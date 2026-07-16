// AF_MCP-2.2 — list_artifacts tool.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  LIST_ARTIFACTS_DESCRIPTION,
  LIST_ARTIFACTS_TOOL,
  buildListArtifactsPath,
  listArtifactsHandler,
  registerListArtifactsTool,
} from "../src/tools/list-artifacts.js";
import {
  resetHttpClient,
  setHttpClient,
} from "../src/http/instance.js";
import {
  clearRegistry,
  getToolRegistration,
} from "../src/safety/registry.js";
import { compileToolSchema, checkToolSchemaContract } from "./_helpers/ajv.js";
import type { ArtifactaHttpClient } from "../src/http/client.js";
import type { HttpResult } from "../src/http/types.js";

let mockRequest: ReturnType<typeof vi.fn>;

function installFakeClient(): void {
  mockRequest = vi.fn();
  const fake = {
    request: (opts: unknown) => mockRequest(opts),
    setConfig: vi.fn(),
  } as unknown as ArtifactaHttpClient;
  setHttpClient(fake);
}

function getRequestedPath(): string {
  expect(mockRequest).toHaveBeenCalled();
  const opts = mockRequest.mock.calls[0][0] as { path: string };
  return opts.path;
}

function getRequestedQuery(): URLSearchParams {
  const path = getRequestedPath();
  const idx = path.indexOf("?");
  return new URLSearchParams(idx >= 0 ? path.slice(idx + 1) : "");
}

const SAMPLE_RESPONSE = {
  artifacts: [
    {
      artifact_id: "art_AAAAAAAAAAAAAAAA",
      filename: "report.pdf",
      created_at: "2026-04-01T00:00:00Z",
    },
  ],
  next_cursor: "cur_xyz",
  has_more: true,
};

beforeEach(() => {
  clearRegistry();
  resetHttpClient();
  installFakeClient();
  registerListArtifactsTool();
});

afterEach(() => {
  clearRegistry();
  resetHttpClient();
  vi.restoreAllMocks();
});

// ─── Tool registration + schema ──────────────────────────────────────────────

describe("AF_MCP-2.2 — list_artifacts registration", () => {
  it("registers tool with name 'list_artifacts' and safety 'safe'", () => {
    const reg = getToolRegistration("list_artifacts");
    expect(reg).toBeDefined();
    expect(reg!.tool.name).toBe("list_artifacts");
    expect(reg!.safety).toBe("safe");
  });

  it("description matches plan §2.2 verbatim", () => {
    expect(LIST_ARTIFACTS_TOOL.description).toBe(LIST_ARTIFACTS_DESCRIPTION);
    expect(LIST_ARTIFACTS_DESCRIPTION).toBe(
      "List artifacts owned by the calling tenant, newest first. Supports filters by `session_id`, `agent_id`, `filename` (exact match), `content_type`, `created_after` / `created_before` (ISO 8601), and one or more `metadata.<key>=<value>` pairs (multi-key requires Pro). Returns a page of artifact records and a `next_cursor` to fetch the next page. Use this to discover what an agent or pipeline produced when you only know a session or agent ID."
    );
  });

  it("input schema satisfies the structural MCP contract", () => {
    expect(checkToolSchemaContract(LIST_ARTIFACTS_TOOL)).toEqual([]);
  });

  it("schema declares the §2.2 fields with the documented bounds", () => {
    const s = LIST_ARTIFACTS_TOOL.inputSchema as Record<string, unknown>;
    const props = s.properties as Record<string, Record<string, unknown>>;
    expect(props.session_id.type).toBe("string");
    expect(props.agent_id.type).toBe("string");
    expect(props.filename.type).toBe("string");
    expect(props.content_type.type).toBe("string");
    expect(props.created_after).toMatchObject({
      type: "string",
      format: "date-time",
    });
    expect(props.created_before).toMatchObject({
      type: "string",
      format: "date-time",
    });
    expect(props.transcript).toMatchObject({
      type: "boolean",
      default: false,
    });
    expect(props.limit).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 200,
      default: 50,
    });
    expect(props.cursor.type).toBe("string");
    expect(props.metadata.type).toBe("object");
    expect(props.metadata.additionalProperties).toBe(false);
    const patternProps = props.metadata.patternProperties as Record<
      string,
      unknown
    >;
    expect(Object.keys(patternProps)).toContain(
      "^[a-zA-Z][a-zA-Z0-9_-]{0,63}$"
    );
  });
});

// ─── AF_MCP-2.2.11 / 2.2.12 / 2.2.16 / 2.2.17 / 2.2.19 — schema rejections ──

describe("AF_MCP-2.2 — schema validation gate", () => {
  it("AF_MCP-2.2.19: rejects extra unknown property", () => {
    const validate = compileToolSchema(LIST_ARTIFACTS_TOOL);
    expect(validate({ unknown_param: "x" })).toBe(false);
  });

  it("AF_MCP-2.2.11: rejects limit:0", () => {
    const validate = compileToolSchema(LIST_ARTIFACTS_TOOL);
    expect(validate({ limit: 0 })).toBe(false);
  });

  it("AF_MCP-2.2.12: rejects limit:201", () => {
    const validate = compileToolSchema(LIST_ARTIFACTS_TOOL);
    expect(validate({ limit: 201 })).toBe(false);
  });

  it("AF_MCP-2.2.16: rejects metadata key that starts with a digit", () => {
    const validate = compileToolSchema(LIST_ARTIFACTS_TOOL);
    expect(validate({ metadata: { "1key": "val" } })).toBe(false);
  });

  it("AF_MCP-2.2.17: rejects metadata key containing a dot", () => {
    const validate = compileToolSchema(LIST_ARTIFACTS_TOOL);
    expect(validate({ metadata: { "key.name": "val" } })).toBe(false);
  });

  it("rejects non-integer limit", () => {
    const validate = compileToolSchema(LIST_ARTIFACTS_TOOL);
    expect(validate({ limit: 1.5 })).toBe(false);
  });

  it("accepts an empty payload", () => {
    const validate = compileToolSchema(LIST_ARTIFACTS_TOOL);
    expect(validate({})).toBe(true);
  });

  it("accepts the full set of valid filters", () => {
    const validate = compileToolSchema(LIST_ARTIFACTS_TOOL);
    expect(
      validate({
        session_id: "sess_1",
        agent_id: "agent_1",
        filename: "x.pdf",
        content_type: "application/pdf",
        created_after: "2026-01-01T00:00:00Z",
        created_before: "2026-12-31T23:59:59Z",
        transcript: true,
        metadata: { env: "prod", model: "gpt-4" },
        limit: 25,
        cursor: "opaque_cursor",
      })
    ).toBe(true);
  });

  it("rejects non-boolean transcript values", () => {
    const validate = compileToolSchema(LIST_ARTIFACTS_TOOL);
    expect(validate({ transcript: "true" })).toBe(false);
  });
});

// ─── buildListArtifactsPath — pure unit ─────────────────────────────────────

describe("AF_MCP-2.2 — buildListArtifactsPath", () => {
  it("AF_MCP-2.2.08: defaults limit to 50 when not provided", () => {
    const path = buildListArtifactsPath({});
    const params = new URLSearchParams(path.split("?")[1]);
    expect(params.get("limit")).toBe("50");
  });

  it("AF_MCP-2.2.10: passes limit=200 through", () => {
    const path = buildListArtifactsPath({ limit: 200 });
    const params = new URLSearchParams(path.split("?")[1]);
    expect(params.get("limit")).toBe("200");
  });

  it("AF_MCP-2.2.09: passes limit=1 through", () => {
    const path = buildListArtifactsPath({ limit: 1 });
    const params = new URLSearchParams(path.split("?")[1]);
    expect(params.get("limit")).toBe("1");
  });

  it("AF_MCP-2.2.13: serializes single metadata key as metadata.<key>=<value>", () => {
    const path = buildListArtifactsPath({ metadata: { env: "prod" } });
    const params = new URLSearchParams(path.split("?")[1]);
    expect(params.get("metadata.env")).toBe("prod");
  });

  it("AF_MCP-2.2.14: emits one metadata.<key>=<value> per entry for multi-key", () => {
    const path = buildListArtifactsPath({
      metadata: { env: "prod", model: "gpt-4" },
    });
    const params = new URLSearchParams(path.split("?")[1]);
    expect(params.get("metadata.env")).toBe("prod");
    expect(params.get("metadata.model")).toBe("gpt-4");
  });

  it("adds exactly one metadata.type filter for transcript sugar", () => {
    const path = buildListArtifactsPath({ transcript: true });
    const params = new URLSearchParams(path.split("?")[1]);
    expect(params.getAll("metadata.type")).toEqual(["transcript"]);
    expect(params.has("transcript")).toBe(false);
  });

  it("preserves an explicit metadata type, including an empty value", () => {
    for (const type of ["conversation", ""]) {
      const path = buildListArtifactsPath({ transcript: true, metadata: { type } });
      const params = new URLSearchParams(path.split("?")[1]);
      expect(params.getAll("metadata.type")).toEqual([type]);
      expect(params.has("transcript")).toBe(false);
    }
  });

  it("copies metadata before merging transcript sugar", () => {
    const metadata = { env: "prod" };
    buildListArtifactsPath({ transcript: true, metadata });
    expect(metadata).toEqual({ env: "prod" });
  });

  it("AF_MCP-2.2.18: cursor is forwarded unchanged (opacity preserved)", () => {
    const opaque = "b64opaquecursor==";
    const path = buildListArtifactsPath({ cursor: opaque });
    const params = new URLSearchParams(path.split("?")[1]);
    expect(params.get("cursor")).toBe(opaque);
  });

  it("AF_MCP-2.2.20: forwards created_after / created_before", () => {
    const path = buildListArtifactsPath({
      created_after: "2025-01-01T00:00:00Z",
      created_before: "2025-12-31T23:59:59Z",
    });
    const params = new URLSearchParams(path.split("?")[1]);
    expect(params.get("created_after")).toBe("2025-01-01T00:00:00Z");
    expect(params.get("created_before")).toBe("2025-12-31T23:59:59Z");
  });

  it("forwards session_id / agent_id / filename / content_type", () => {
    const path = buildListArtifactsPath({
      session_id: "sess_X",
      agent_id: "agent_Y",
      filename: "report.pdf",
      content_type: "application/pdf",
    });
    const params = new URLSearchParams(path.split("?")[1]);
    expect(params.get("session_id")).toBe("sess_X");
    expect(params.get("agent_id")).toBe("agent_Y");
    expect(params.get("filename")).toBe("report.pdf");
    expect(params.get("content_type")).toBe("application/pdf");
  });

  it("URL-encodes values that contain reserved characters", () => {
    const path = buildListArtifactsPath({ filename: "a b/c?d" });
    // URLSearchParams encodes space as '+', '/' and '?' as %2F / %3F.
    expect(path).toContain("filename=a+b%2Fc%3Fd");
  });
});

// ─── Tool handler — AF_MCP-2.2.01–07, 2.2.13–18 ──────────────────────────────

describe("AF_MCP-2.2 — list_artifacts handler", () => {
  it("rejects a present non-boolean transcript before client acquisition", async () => {
    resetHttpClient();
    const result = await listArtifactsHandler({ transcript: "true" });
    expect(result.isError).toBe(true);
    expect((result._meta as { code: string }).code).toBe("invalid_request");
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("normalizes transcript sugar into the existing metadata query", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: SAMPLE_RESPONSE,
    } satisfies HttpResult);
    await listArtifactsHandler({
      session_id: "sess_1",
      transcript: true,
      metadata: { env: "prod" },
    });
    const params = getRequestedQuery();
    expect(params.get("session_id")).toBe("sess_1");
    expect(params.get("metadata.env")).toBe("prod");
    expect(params.getAll("metadata.type")).toEqual(["transcript"]);
    expect(params.has("transcript")).toBe(false);
  });

  it("AF_MCP-2.2.01: empty filters → calls GET /v1/artifacts and returns the API body", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: SAMPLE_RESPONSE,
    } satisfies HttpResult);

    const result: CallToolResult = await listArtifactsHandler({});
    expect(result.isError).toBeUndefined();
    const path = getRequestedPath();
    expect(path.startsWith("/v1/artifacts?")).toBe(true);
    const opts = mockRequest.mock.calls[0][0] as { method: string; retryPolicy: string };
    expect(opts.method).toBe("GET");
    expect(opts.retryPolicy).toBe("read");

    const text = (result.content[0] as { text: string }).text;
    expect(JSON.parse(text)).toEqual(SAMPLE_RESPONSE);
  });

  it("AF_MCP-2.2.02: forwards session_id", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: SAMPLE_RESPONSE,
    } satisfies HttpResult);
    await listArtifactsHandler({ session_id: "sess_1" });
    expect(getRequestedQuery().get("session_id")).toBe("sess_1");
  });

  it("AF_MCP-2.2.03: forwards agent_id", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: SAMPLE_RESPONSE,
    } satisfies HttpResult);
    await listArtifactsHandler({ agent_id: "agent_1" });
    expect(getRequestedQuery().get("agent_id")).toBe("agent_1");
  });

  it("AF_MCP-2.2.04: forwards filename", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: SAMPLE_RESPONSE,
    } satisfies HttpResult);
    await listArtifactsHandler({ filename: "report.pdf" });
    expect(getRequestedQuery().get("filename")).toBe("report.pdf");
  });

  it("AF_MCP-2.2.05: passes through API ordering (newest-first; trust the API)", async () => {
    // The MCP server does no client-side reordering. Verify that whatever the
    // API returns lands in the result text verbatim, in the same order.
    const ordered = {
      artifacts: [
        { artifact_id: "art_NEW", created_at: "2026-04-02T00:00:00Z" },
        { artifact_id: "art_OLD", created_at: "2026-04-01T00:00:00Z" },
      ],
      next_cursor: null,
      has_more: false,
    };
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: ordered,
    } satisfies HttpResult);
    const result = await listArtifactsHandler({ limit: 5 });
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.artifacts[0].artifact_id).toBe("art_NEW");
    expect(parsed.artifacts[1].artifact_id).toBe("art_OLD");
  });

  it("AF_MCP-2.2.06: pagination — second-page request forwards cursor verbatim", async () => {
    // First page returns next_cursor.
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { artifacts: [], next_cursor: "page2_cur", has_more: true },
    } satisfies HttpResult);
    const first = await listArtifactsHandler({ limit: 2 });
    const firstParsed = JSON.parse(
      (first.content[0] as { text: string }).text
    );
    expect(firstParsed.next_cursor).toBe("page2_cur");

    // Second page: agent calls again with the cursor — should appear in query
    // as the literal string we got back, no decoding/mutation.
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { artifacts: [], next_cursor: null, has_more: false },
    } satisfies HttpResult);
    await listArtifactsHandler({ cursor: "page2_cur", limit: 2 });

    const secondPath = mockRequest.mock.calls[1][0] as { path: string };
    const params = new URLSearchParams(secondPath.path.split("?")[1]);
    expect(params.get("cursor")).toBe("page2_cur");
  });

  it("AF_MCP-2.2.07: empty result returns the empty shape, not an error", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { artifacts: [], next_cursor: null, has_more: false },
    } satisfies HttpResult);
    const result = await listArtifactsHandler({ agent_id: "nonexistent" });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toEqual({
      artifacts: [],
      next_cursor: null,
      has_more: false,
    });
  });

  it("AF_MCP-2.2.13: single-key metadata → metadata.<key>=<value>", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: SAMPLE_RESPONSE,
    } satisfies HttpResult);
    await listArtifactsHandler({ metadata: { env: "prod" } });
    expect(getRequestedQuery().get("metadata.env")).toBe("prod");
  });

  it("AF_MCP-2.2.14: multi-key metadata on Pro → both params forwarded; result returned", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: SAMPLE_RESPONSE,
    } satisfies HttpResult);
    const result = await listArtifactsHandler({
      metadata: { env: "prod", model: "gpt-4" },
    });
    const params = getRequestedQuery();
    expect(params.get("metadata.env")).toBe("prod");
    expect(params.get("metadata.model")).toBe("gpt-4");
    expect(result.isError).toBeUndefined();
  });

  it("AF_MCP-2.2.15: multi-key metadata on Free → translated quota_exceeded with upgrade", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: false,
      status: 403,
      error: {
        code: "quota_exceeded",
        message:
          "Multiple metadata filters require a Pro plan. Filter by one metadata key on Free, or upgrade at https://app.artifacta.io/dashboard/billing",
        status: 403,
        upgrade_url: "https://app.artifacta.io/dashboard/billing",
      },
      attempts: 1,
    } satisfies HttpResult);
    const result = await listArtifactsHandler({
      metadata: { env: "prod", model: "gpt-4" },
    });
    expect(result.isError).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.code).toBe("quota_exceeded");
    expect(meta?.upgrade_url).toBe(
      "https://app.artifacta.io/dashboard/billing"
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Pro plan");
    expect(text).toContain("https://app.artifacta.io/dashboard/billing");
  });

  it("AF_MCP-2.2.16: invalid metadata key (digit-prefix) — translated invalid_request from API", async () => {
    // The MCP server forwards verbatim; the API rejects.
    mockRequest.mockResolvedValueOnce({
      ok: false,
      status: 400,
      error: {
        code: "invalid_request",
        message:
          "Invalid metadata filter key '1key'. Keys must match ^[a-zA-Z][a-zA-Z0-9_-]{0,63}$.",
        status: 400,
      },
      attempts: 1,
    } satisfies HttpResult);
    const result = await listArtifactsHandler({
      metadata: { "1key": "val" } as unknown as Record<string, string>,
    });
    expect(result.isError).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.code).toBe("invalid_request");
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Invalid metadata filter key");
  });

  it("AF_MCP-2.2.18: cursor forwarded unchanged when present", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: SAMPLE_RESPONSE,
    } satisfies HttpResult);
    await listArtifactsHandler({ cursor: "b64opaquecursor==" });
    // URLSearchParams encodes '=' so the wire form is `b64opaquecursor%3D%3D`,
    // but it round-trips back through URLSearchParams.get to the same string.
    expect(getRequestedQuery().get("cursor")).toBe("b64opaquecursor==");
  });

  it("AF_MCP-2.2.20: created_after/before forwarded", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: SAMPLE_RESPONSE,
    } satisfies HttpResult);
    await listArtifactsHandler({
      created_after: "2025-01-01T00:00:00Z",
      created_before: "2025-12-31T23:59:59Z",
    });
    const params = getRequestedQuery();
    expect(params.get("created_after")).toBe("2025-01-01T00:00:00Z");
    expect(params.get("created_before")).toBe("2025-12-31T23:59:59Z");
  });

  it("returns translated server_error on transport failure", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: false,
      status: 0,
      error: { code: "network_error", message: "ECONNREFUSED", status: 0 },
      attempts: 4,
    } satisfies HttpResult);
    const result = await listArtifactsHandler({});
    expect(result.isError).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.retry_hint).toBe("retry_with_backoff");
  });
});
