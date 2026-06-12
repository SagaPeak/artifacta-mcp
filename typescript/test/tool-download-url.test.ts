// AF_MCP-2.4 — get_artifact_download_url tool.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  GET_ARTIFACT_DOWNLOAD_URL_DESCRIPTION,
  GET_ARTIFACT_DOWNLOAD_URL_TOOL,
  getArtifactDownloadUrlHandler,
  registerGetArtifactDownloadUrlTool,
} from "../src/tools/get-artifact-download-url.js";
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
const SUCCESS_BODY = {
  download_url:
    "https://r2.example.io/blob/tenant_x/abc123/file.pdf?X-Amz-Signature=...",
  expires_in: 3600,
  filename: "report.pdf",
  content_type: "application/pdf",
  size_bytes: 12345,
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
  registerGetArtifactDownloadUrlTool();
});

afterEach(() => {
  clearRegistry();
  resetHttpClient();
  vi.restoreAllMocks();
});

// ─── Registration + schema ───────────────────────────────────────────────────

describe("AF_MCP-2.4 — get_artifact_download_url registration", () => {
  it("registers tool name 'get_artifact_download_url' with safety 'safe'", () => {
    const reg = getToolRegistration("get_artifact_download_url");
    expect(reg).toBeDefined();
    expect(reg!.tool.name).toBe("get_artifact_download_url");
    expect(reg!.safety).toBe("safe");
  });

  it("description matches plan §2.4 verbatim", () => {
    expect(GET_ARTIFACT_DOWNLOAD_URL_TOOL.description).toBe(
      GET_ARTIFACT_DOWNLOAD_URL_DESCRIPTION
    );
    expect(GET_ARTIFACT_DOWNLOAD_URL_DESCRIPTION).toBe(
      "Generate a short-lived presigned URL (1 hour) the agent can use to download the artifact's bytes directly from Cloudflare R2. Use this when the agent itself needs to consume the file. For sharing with humans, use `create_download_link` instead — that produces a stable `dl.artifacta.io/lnk_…` URL with configurable expiry."
    );
  });

  it("AF_MCP-2.4.08: description steers toward create_download_link for human sharing", () => {
    expect(GET_ARTIFACT_DOWNLOAD_URL_DESCRIPTION).toContain(
      "create_download_link"
    );
    expect(GET_ARTIFACT_DOWNLOAD_URL_DESCRIPTION).toMatch(/sharing with humans/i);
  });

  it("input schema satisfies the structural MCP contract", () => {
    expect(checkToolSchemaContract(GET_ARTIFACT_DOWNLOAD_URL_TOOL)).toEqual([]);
  });

  it("input schema requires artifact_id and pins the ARTIFACT_ID_PATTERN constant", () => {
    const s = GET_ARTIFACT_DOWNLOAD_URL_TOOL.inputSchema as Record<
      string,
      unknown
    >;
    expect(s.required).toEqual(["artifact_id"]);
    const props = s.properties as Record<string, Record<string, unknown>>;
    expect(props.artifact_id.pattern).toBe(ARTIFACT_ID_PATTERN);
  });
});

// ─── Schema gate (AF_MCP-2.4.07) ─────────────────────────────────────────────

describe("AF_MCP-2.4 — schema validation gate", () => {
  it("AF_MCP-2.4.07: rejects invalid artifact_id (no prefix)", () => {
    const validate = compileToolSchema(GET_ARTIFACT_DOWNLOAD_URL_TOOL);
    expect(validate({ artifact_id: "invalid" })).toBe(false);
  });

  it("rejects 15-char id (one short)", () => {
    const validate = compileToolSchema(GET_ARTIFACT_DOWNLOAD_URL_TOOL);
    expect(validate({ artifact_id: "art_123456789012345" })).toBe(false);
  });

  it("rejects extra properties", () => {
    const validate = compileToolSchema(GET_ARTIFACT_DOWNLOAD_URL_TOOL);
    expect(validate({ artifact_id: VALID_ID, extra: 1 })).toBe(false);
  });

  it("rejects payload missing artifact_id", () => {
    const validate = compileToolSchema(GET_ARTIFACT_DOWNLOAD_URL_TOOL);
    expect(validate({})).toBe(false);
  });

  it("accepts a valid 16-char alnum id", () => {
    const validate = compileToolSchema(GET_ARTIFACT_DOWNLOAD_URL_TOOL);
    expect(validate({ artifact_id: VALID_ID })).toBe(true);
  });
});

// ─── Handler — happy path + error translation ───────────────────────────────

describe("AF_MCP-2.4 — get_artifact_download_url handler", () => {
  it("AF_MCP-2.4.01: valid id → calls GET /v1/artifacts/{id}/download-url and returns JSON", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: SUCCESS_BODY,
    } satisfies HttpResult);

    const result = await getArtifactDownloadUrlHandler({
      artifact_id: VALID_ID,
    });
    expect(result.isError).toBeUndefined();
    expect(mockRequest).toHaveBeenCalledOnce();
    const opts = mockRequest.mock.calls[0][0] as {
      method: string;
      path: string;
      retryPolicy: string;
    };
    expect(opts.method).toBe("GET");
    expect(opts.path).toBe(`/v1/artifacts/${VALID_ID}/download-url`);
    expect(opts.retryPolicy).toBe("read");

    const parsed = JSON.parse(
      (result.content[0] as { text: string }).text
    ) as Record<string, unknown>;
    expect(parsed).toEqual(SUCCESS_BODY);
  });

  it("AF_MCP-2.4.02: passes expires_in: 3600 through verbatim", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: SUCCESS_BODY,
    } satisfies HttpResult);
    const result = await getArtifactDownloadUrlHandler({
      artifact_id: VALID_ID,
    });
    const parsed = JSON.parse(
      (result.content[0] as { text: string }).text
    ) as { expires_in: number };
    expect(parsed.expires_in).toBe(3600);
  });

  it("returns the full §2.4 success shape (download_url + expires_in + filename + content_type + size_bytes)", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: SUCCESS_BODY,
    } satisfies HttpResult);
    const result = await getArtifactDownloadUrlHandler({
      artifact_id: VALID_ID,
    });
    const parsed = JSON.parse(
      (result.content[0] as { text: string }).text
    ) as Record<string, unknown>;
    expect(parsed.download_url).toBe(SUCCESS_BODY.download_url);
    expect(parsed.expires_in).toBe(3600);
    expect(parsed.filename).toBe("report.pdf");
    expect(parsed.content_type).toBe("application/pdf");
    expect(parsed.size_bytes).toBe(12345);
  });

  it("AF_MCP-2.4.04: artifact_not_found translated", async () => {
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
    const result = await getArtifactDownloadUrlHandler({
      artifact_id: VALID_ID,
    });
    expect(result.isError).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.code).toBe("artifact_not_found");
    expect(meta?.retry_hint).toBe("do_not_retry");
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("does not exist or is not visible");
  });

  it("AF_MCP-2.4.05: artifact_expired translated (410)", async () => {
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
    const result = await getArtifactDownloadUrlHandler({
      artifact_id: VALID_ID,
    });
    expect(result.isError).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.code).toBe("artifact_expired");
    const text = (result.content[0] as { text: string }).text;
    expect(text.toLowerCase()).toContain("expired");
  });

  it("AF_MCP-2.4.06: artifact_already_deleted translated (410)", async () => {
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
    const result = await getArtifactDownloadUrlHandler({
      artifact_id: VALID_ID,
    });
    expect(result.isError).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.code).toBe("artifact_already_deleted");
    const text = (result.content[0] as { text: string }).text;
    expect(text.toLowerCase()).toContain("deleted");
  });

  it("returns defensive invalid_request when artifact_id is missing at runtime", async () => {
    const result = await getArtifactDownloadUrlHandler({});
    expect(result.isError).toBe(true);
    expect(mockRequest).not.toHaveBeenCalled();
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.code).toBe("invalid_request");
  });
});
