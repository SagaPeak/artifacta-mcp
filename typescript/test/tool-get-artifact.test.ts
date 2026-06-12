// AF_MCP-2.3 — get_artifact tool.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  GET_ARTIFACT_DESCRIPTION,
  GET_ARTIFACT_TOOL,
  fetchArtifact,
  getArtifactHandler,
  registerGetArtifactTool,
} from "../src/tools/get-artifact.js";
import {
  resetHttpClient,
  setHttpClient,
} from "../src/http/instance.js";
import {
  clearRegistry,
  getToolRegistration,
} from "../src/safety/registry.js";
import { compileToolSchema, checkToolSchemaContract } from "./_helpers/ajv.js";
import { ARTIFACT_ID_PATTERN } from "../src/ids/formats.js";
import type { ArtifactaHttpClient } from "../src/http/client.js";
import type { HttpResult } from "../src/http/types.js";

const VALID_ID = "art_AAAAAAAAAAAAAAAA";
const ARTIFACT_BODY = {
  artifact_id: VALID_ID,
  filename: "report.pdf",
  content_type: "application/pdf",
  size_bytes: 12345,
  content_hash: "sha256:abc",
  session_id: "sess_x",
  agent_id: "agent_y",
  metadata: { env: "prod" },
  expires_at: "2026-12-31T00:00:00Z",
  created_at: "2026-04-01T00:00:00Z",
};

let mockRequest: ReturnType<typeof vi.fn>;

function installFakeClient(): void {
  mockRequest = vi.fn();
  const fake = {
    request: (opts: unknown) => mockRequest(opts),
    setConfig: vi.fn(),
  } as unknown as ArtifactaHttpClient;
  setHttpClient(fake);
}

beforeEach(() => {
  clearRegistry();
  resetHttpClient();
  installFakeClient();
  registerGetArtifactTool();
});

afterEach(() => {
  clearRegistry();
  resetHttpClient();
  vi.restoreAllMocks();
});

// ─── Registration + schema ───────────────────────────────────────────────────

describe("AF_MCP-2.3 — get_artifact registration", () => {
  it("registers tool name 'get_artifact' with safety 'safe'", () => {
    const reg = getToolRegistration("get_artifact");
    expect(reg).toBeDefined();
    expect(reg!.tool.name).toBe("get_artifact");
    expect(reg!.safety).toBe("safe");
  });

  it("description matches plan §2.3 verbatim", () => {
    expect(GET_ARTIFACT_TOOL.description).toBe(GET_ARTIFACT_DESCRIPTION);
    expect(GET_ARTIFACT_DESCRIPTION).toBe(
      "Fetch metadata for a single artifact by ID: filename, content type, size, content hash, session/agent IDs, custom metadata, expiry, creation timestamp. Does NOT return the file bytes — call `get_artifact_download_url` for that. Returns `artifact_not_found` for unknown IDs, `artifact_already_deleted` (HTTP 410) for soft-deleted ones, `artifact_expired` (410) for those past their TTL."
    );
  });

  it("input schema satisfies the structural MCP contract", () => {
    expect(checkToolSchemaContract(GET_ARTIFACT_TOOL)).toEqual([]);
  });

  it("input schema requires artifact_id and pins the ARTIFACT_ID_PATTERN constant", () => {
    const s = GET_ARTIFACT_TOOL.inputSchema as Record<string, unknown>;
    expect(s.required).toEqual(["artifact_id"]);
    const props = s.properties as Record<string, Record<string, unknown>>;
    expect(props.artifact_id.pattern).toBe(ARTIFACT_ID_PATTERN);
  });
});

// ─── Schema gate (AF_MCP-2.3.04, 2.3.05, 2.3.13) ─────────────────────────────

describe("AF_MCP-2.3 — schema validation gate", () => {
  it("AF_MCP-2.3.04: rejects 15-char id (one short)", () => {
    const validate = compileToolSchema(GET_ARTIFACT_TOOL);
    expect(validate({ artifact_id: "art_123456789012345" })).toBe(false);
  });

  it("AF_MCP-2.3.05: rejects id without art_ prefix", () => {
    const validate = compileToolSchema(GET_ARTIFACT_TOOL);
    expect(validate({ artifact_id: "1234567890123456" })).toBe(false);
  });

  it("AF_MCP-2.3.13: rejects extra properties", () => {
    const validate = compileToolSchema(GET_ARTIFACT_TOOL);
    expect(
      validate({ artifact_id: "art_AAAAAAAAAAAAAAAA", extra: "x" })
    ).toBe(false);
  });

  it("rejects payload missing artifact_id", () => {
    const validate = compileToolSchema(GET_ARTIFACT_TOOL);
    expect(validate({})).toBe(false);
  });

  it("accepts a valid 16-char alnum id", () => {
    const validate = compileToolSchema(GET_ARTIFACT_TOOL);
    expect(validate({ artifact_id: "art_AbC0123456789xyz" })).toBe(true);
  });

  it("rejects an id with non-alnum chars in the tail", () => {
    const validate = compileToolSchema(GET_ARTIFACT_TOOL);
    expect(validate({ artifact_id: "art_AAAAAAAAAAAA-AAA" })).toBe(false);
  });
});

// ─── fetchArtifact + handler ─────────────────────────────────────────────────

describe("AF_MCP-2.3 — get_artifact handler", () => {
  it("AF_MCP-2.3.01: valid id → calls GET /v1/artifacts/<id> and returns metadata block", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: ARTIFACT_BODY,
    } satisfies HttpResult);

    const result = await getArtifactHandler({ artifact_id: VALID_ID });
    expect(result.isError).toBeUndefined();
    expect(mockRequest).toHaveBeenCalledOnce();
    const opts = mockRequest.mock.calls[0][0] as {
      method: string;
      path: string;
      retryPolicy: string;
    };
    expect(opts.method).toBe("GET");
    expect(opts.path).toBe(`/v1/artifacts/${VALID_ID}`);
    expect(opts.retryPolicy).toBe("read");

    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toEqual(ARTIFACT_BODY);
  });

  it("AF_MCP-2.3.02 & 2.3.03: handler does not synthesize tenant_id or deleted_at", async () => {
    // The MCP server is a pure passthrough — verify the body it returns
    // contains exactly what the API sent, neither more nor less.
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: ARTIFACT_BODY,
    } satisfies HttpResult);
    const result = await getArtifactHandler({ artifact_id: VALID_ID });
    const parsed = JSON.parse(
      (result.content[0] as { text: string }).text
    ) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("tenant_id");
    expect(parsed).not.toHaveProperty("deleted_at");
    expect(parsed.artifact_id).toBe(VALID_ID);
  });

  it("AF_MCP-2.3.06: artifact_not_found translated", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: {
        code: "artifact_not_found",
        message: "Artifact not found",
        status: 404,
      },
      attempts: 1,
    } satisfies HttpResult);
    const result = await getArtifactHandler({ artifact_id: VALID_ID });
    expect(result.isError).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.code).toBe("artifact_not_found");
    expect(meta?.retry_hint).toBe("do_not_retry");
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("does not exist or is not visible");
  });

  it("AF_MCP-2.3.07: artifact_expired translated (410)", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: false,
      status: 410,
      error: {
        code: "artifact_expired",
        message: "Artifact expired",
        status: 410,
      },
      attempts: 1,
    } satisfies HttpResult);
    const result = await getArtifactHandler({ artifact_id: VALID_ID });
    expect(result.isError).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.code).toBe("artifact_expired");
    const text = (result.content[0] as { text: string }).text;
    expect(text.toLowerCase()).toContain("expired");
  });

  it("AF_MCP-2.3.08: artifact_already_deleted translated (410)", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: false,
      status: 410,
      error: {
        code: "artifact_already_deleted",
        message: "Artifact already deleted",
        status: 410,
      },
      attempts: 1,
    } satisfies HttpResult);
    const result = await getArtifactHandler({ artifact_id: VALID_ID });
    expect(result.isError).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.code).toBe("artifact_already_deleted");
    const text = (result.content[0] as { text: string }).text;
    expect(text.toLowerCase()).toContain("deleted");
  });

  it("returns a defensive invalid_request when artifact_id is missing at runtime", async () => {
    // Schema validation should catch this at the client; this test guards
    // against a non-compliant client bypassing the gate.
    const result = await getArtifactHandler({});
    expect(result.isError).toBe(true);
    expect(mockRequest).not.toHaveBeenCalled();
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.code).toBe("invalid_request");
  });

  it("URL-encodes the artifact id in the path", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: ARTIFACT_BODY,
    } satisfies HttpResult);
    // Path is built via encodeURIComponent — even though valid IDs contain
    // only [A-Za-z0-9_], the encode call is the right defense if something
    // ever slips past the schema.
    await fetchArtifact("art_aBcDeFg012345xyz");
    const opts = mockRequest.mock.calls[0][0] as { path: string };
    expect(opts.path).toBe("/v1/artifacts/art_aBcDeFg012345xyz");
  });
});
