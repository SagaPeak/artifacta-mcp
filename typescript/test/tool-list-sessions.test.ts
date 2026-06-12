// AF_MCP-2.5 — list_sessions tool + artifacta://session/{session_id} resource.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  LIST_SESSIONS_DESCRIPTION,
  LIST_SESSIONS_TOOL,
  buildListSessionsPath,
  listSessionsHandler,
  registerListSessionsTool,
} from "../src/tools/list-sessions.js";
import {
  SESSION_RESOURCE_TEMPLATE,
  registerSessionResource,
} from "../src/resources/session.js";
import {
  resetHttpClient,
  setHttpClient,
} from "../src/http/instance.js";
import {
  clearRegistry,
  getToolRegistration,
} from "../src/safety/registry.js";
import {
  clearResourceRegistry,
  listResourceTemplates,
  matchResourceTemplate,
} from "../src/resources/registry.js";
import { compileToolSchema, checkToolSchemaContract } from "./_helpers/ajv.js";
import type { ArtifactaHttpClient } from "../src/http/client.js";
import type { HttpResult } from "../src/http/types.js";

const SAMPLE_SESSION = {
  session_id: "sess_abc",
  artifact_count: 3,
  is_sealed: false,
  first_artifact_at: "2026-04-01T00:00:00Z",
  last_artifact_at: "2026-04-02T00:00:00Z",
};
const SECOND_SESSION = {
  session_id: "sess_xyz",
  artifact_count: 1,
  is_sealed: true,
  first_artifact_at: "2026-03-30T00:00:00Z",
  last_artifact_at: "2026-03-30T00:00:00Z",
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

function getRequestedQuery(callIdx = 0): URLSearchParams {
  const path = (mockRequest.mock.calls[callIdx][0] as { path: string }).path;
  const idx = path.indexOf("?");
  return new URLSearchParams(idx >= 0 ? path.slice(idx + 1) : "");
}

beforeEach(() => {
  clearRegistry();
  clearResourceRegistry();
  resetHttpClient();
  installFakeClient();
  registerListSessionsTool();
  registerSessionResource();
});

afterEach(() => {
  clearRegistry();
  clearResourceRegistry();
  resetHttpClient();
  vi.restoreAllMocks();
});

// ─── Registration + schema ───────────────────────────────────────────────────

describe("AF_MCP-2.5 — list_sessions registration", () => {
  it("registers tool name 'list_sessions' with safety 'safe'", () => {
    const reg = getToolRegistration("list_sessions");
    expect(reg).toBeDefined();
    expect(reg!.tool.name).toBe("list_sessions");
    expect(reg!.safety).toBe("safe");
  });

  it("description matches plan §2.10 verbatim", () => {
    expect(LIST_SESSIONS_TOOL.description).toBe(LIST_SESSIONS_DESCRIPTION);
    expect(LIST_SESSIONS_DESCRIPTION).toBe(
      "List session IDs synthesized from the calling tenant's artifacts, ordered by most recent activity. Each entry includes artifact count, seal status, and first/last activity timestamps. Sessions are not first-class — they exist only as long as artifacts reference them."
    );
  });

  it("input schema satisfies the structural MCP contract", () => {
    expect(checkToolSchemaContract(LIST_SESSIONS_TOOL)).toEqual([]);
  });

  it("schema declares the §2.10 fields with documented bounds", () => {
    const s = LIST_SESSIONS_TOOL.inputSchema as Record<string, unknown>;
    const props = s.properties as Record<string, Record<string, unknown>>;
    expect(props.created_after).toMatchObject({
      type: "string",
      format: "date-time",
    });
    expect(props.created_before).toMatchObject({
      type: "string",
      format: "date-time",
    });
    expect(props.limit).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 200,
      default: 50,
    });
    expect(props.cursor.type).toBe("string");
  });
});

// ─── Schema gate (AF_MCP-2.5.12) ─────────────────────────────────────────────

describe("AF_MCP-2.5 — schema validation gate", () => {
  it("AF_MCP-2.5.12: rejects extra unknown property", () => {
    const validate = compileToolSchema(LIST_SESSIONS_TOOL);
    expect(validate({ unknown: "x" })).toBe(false);
  });

  it("rejects limit:0", () => {
    const validate = compileToolSchema(LIST_SESSIONS_TOOL);
    expect(validate({ limit: 0 })).toBe(false);
  });

  it("rejects limit:201", () => {
    const validate = compileToolSchema(LIST_SESSIONS_TOOL);
    expect(validate({ limit: 201 })).toBe(false);
  });

  it("rejects non-integer limit", () => {
    const validate = compileToolSchema(LIST_SESSIONS_TOOL);
    expect(validate({ limit: 1.5 })).toBe(false);
  });

  it("accepts an empty payload", () => {
    const validate = compileToolSchema(LIST_SESSIONS_TOOL);
    expect(validate({})).toBe(true);
  });

  it("accepts the full set of valid filters", () => {
    const validate = compileToolSchema(LIST_SESSIONS_TOOL);
    expect(
      validate({
        created_after: "2026-01-01T00:00:00Z",
        created_before: "2026-12-31T23:59:59Z",
        limit: 25,
        cursor: "opaque",
      })
    ).toBe(true);
  });
});

// ─── buildListSessionsPath — pure unit ──────────────────────────────────────

describe("AF_MCP-2.5 — buildListSessionsPath", () => {
  it("AF_MCP-2.5.07: defaults limit to 50 when not provided", () => {
    const params = new URLSearchParams(buildListSessionsPath({}).split("?")[1]);
    expect(params.get("limit")).toBe("50");
  });

  it("AF_MCP-2.5.08: passes limit=200 through", () => {
    const params = new URLSearchParams(
      buildListSessionsPath({ limit: 200 }).split("?")[1]
    );
    expect(params.get("limit")).toBe("200");
  });

  it("AF_MCP-2.5.06: forwards created_after / created_before", () => {
    const params = new URLSearchParams(
      buildListSessionsPath({
        created_after: "2025-01-01T00:00:00Z",
        created_before: "2025-12-31T23:59:59Z",
      }).split("?")[1]
    );
    expect(params.get("created_after")).toBe("2025-01-01T00:00:00Z");
    expect(params.get("created_before")).toBe("2025-12-31T23:59:59Z");
  });

  it("translates MCP `cursor` to the wire `after` query param", () => {
    const params = new URLSearchParams(
      buildListSessionsPath({ cursor: "opaque_cursor" }).split("?")[1]
    );
    expect(params.get("after")).toBe("opaque_cursor");
    expect(params.get("cursor")).toBeNull();
  });
});

// ─── Tool handler ────────────────────────────────────────────────────────────

describe("AF_MCP-2.5 — list_sessions handler", () => {
  it("AF_MCP-2.5.01: empty filters → calls GET /v1/sessions and returns the API body", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        sessions: [SAMPLE_SESSION],
        next_cursor: null,
        has_more: false,
      },
    } satisfies HttpResult);
    const result = await listSessionsHandler({});
    expect(result.isError).toBeUndefined();
    const opts = mockRequest.mock.calls[0][0] as {
      method: string;
      path: string;
      retryPolicy: string;
    };
    expect(opts.method).toBe("GET");
    expect(opts.path.startsWith("/v1/sessions?")).toBe(true);
    expect(opts.retryPolicy).toBe("read");

    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.sessions[0]).toEqual(SAMPLE_SESSION);
  });

  it("AF_MCP-2.5.02: each session entry exposes the 5 expected fields", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        sessions: [SAMPLE_SESSION],
        next_cursor: null,
        has_more: false,
      },
    } satisfies HttpResult);
    const result = await listSessionsHandler({ limit: 1 });
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    const s = parsed.sessions[0];
    expect(s).toHaveProperty("session_id");
    expect(s).toHaveProperty("artifact_count");
    expect(s).toHaveProperty("is_sealed");
    expect(s).toHaveProperty("first_artifact_at");
    expect(s).toHaveProperty("last_artifact_at");
  });

  it("AF_MCP-2.5.03: passes through has_more=true / next_cursor=string when API reports more", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        sessions: [SAMPLE_SESSION],
        next_cursor: "page2_token",
        has_more: true,
      },
    } satisfies HttpResult);
    const result = await listSessionsHandler({ limit: 1 });
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text);
    expect(parsed.has_more).toBe(true);
    expect(parsed.next_cursor).toBe("page2_token");
  });

  it("AF_MCP-2.5.04: empty result returns the empty shape, not an error", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { sessions: [], next_cursor: null, has_more: false },
    } satisfies HttpResult);
    const result = await listSessionsHandler({});
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed).toEqual({
      sessions: [],
      next_cursor: null,
      has_more: false,
    });
  });

  it("AF_MCP-2.5.05: pagination — second-page request forwards cursor as `after`", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        sessions: [SAMPLE_SESSION],
        next_cursor: "p2",
        has_more: true,
      },
    } satisfies HttpResult);
    const first = await listSessionsHandler({ limit: 1 });
    const firstParsed = JSON.parse(
      (first.content[0] as { text: string }).text
    );
    expect(firstParsed.next_cursor).toBe("p2");

    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { sessions: [SECOND_SESSION], next_cursor: null, has_more: false },
    } satisfies HttpResult);
    await listSessionsHandler({ cursor: "p2", limit: 1 });
    expect(getRequestedQuery(1).get("after")).toBe("p2");
  });

  it("AF_MCP-2.5.13: passes is_sealed through verbatim from the API response", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        sessions: [SECOND_SESSION], // is_sealed: true
        next_cursor: null,
        has_more: false,
      },
    } satisfies HttpResult);
    const result = await listSessionsHandler({});
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.sessions[0].is_sealed).toBe(true);
  });

  it("returns translated server_error on transport failure", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: false,
      status: 0,
      error: { code: "network_error", message: "ECONNREFUSED", status: 0 },
      attempts: 4,
    } satisfies HttpResult);
    const result = await listSessionsHandler({});
    expect(result.isError).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.retry_hint).toBe("retry_with_backoff");
  });
});

// ─── Resource template (AF_MCP-2.5.09–10) ────────────────────────────────────

describe("AF_MCP-2.5 — artifacta://session/{session_id} resource", () => {
  it("AF_MCP-2.5.09: resources/templates/list contains the session template", () => {
    const t = listResourceTemplates().find(
      (x) => x.uriTemplate === "artifacta://session/{session_id}"
    );
    expect(t).toBeDefined();
    expect(t!.mimeType).toBe("application/json");
    expect(t!.name).toBe("session");
    expect(SESSION_RESOURCE_TEMPLATE.uriTemplate).toBe(
      "artifacta://session/{session_id}"
    );
  });

  it("template URI matches a concrete URI and extracts session_id", () => {
    const m = matchResourceTemplate("artifacta://session/sess_abc");
    expect(m).toBeDefined();
    expect(m!.params.session_id).toBe("sess_abc");
  });

  it("AF_MCP-2.5.10: resource read returns the aggregate view", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        sessions: [SECOND_SESSION, SAMPLE_SESSION],
        next_cursor: null,
        has_more: false,
      },
    } satisfies HttpResult);
    const m = matchResourceTemplate(
      `artifacta://session/${SAMPLE_SESSION.session_id}`
    )!;
    const result = await m.read(
      `artifacta://session/${SAMPLE_SESSION.session_id}`,
      m.params
    );
    expect(result.contents).toHaveLength(1);
    const c = result.contents[0] as {
      uri: string;
      mimeType?: string;
      text: string;
    };
    expect(c.uri).toBe(`artifacta://session/${SAMPLE_SESSION.session_id}`);
    expect(c.mimeType).toBe("application/json");
    expect(JSON.parse(c.text)).toEqual(SAMPLE_SESSION);
  });

  it("paginates /v1/sessions until the target session_id is found", async () => {
    // Page 1 — does not contain target.
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        sessions: [SECOND_SESSION],
        next_cursor: "page2",
        has_more: true,
      },
    } satisfies HttpResult);
    // Page 2 — contains target.
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        sessions: [SAMPLE_SESSION],
        next_cursor: null,
        has_more: false,
      },
    } satisfies HttpResult);
    const m = matchResourceTemplate(
      `artifacta://session/${SAMPLE_SESSION.session_id}`
    )!;
    const result = await m.read(
      `artifacta://session/${SAMPLE_SESSION.session_id}`,
      m.params
    );
    expect(JSON.parse((result.contents[0] as { text: string }).text)).toEqual(
      SAMPLE_SESSION
    );
    // Second call carried the cursor as `after`.
    expect(getRequestedQuery(1).get("after")).toBe("page2");
  });

  it("Adversarial regression — finds a target session past page 10 (Codex review 2026-05-08)", async () => {
    // Codex review of HEAD~6..HEAD flagged that the previous 10-page cap
    // would silently turn an existing session deep in history into
    // session_not_found. Walk past page 10 and confirm the target is
    // discovered correctly.
    const TARGET_PAGE = 13; // beyond the old MAX_PAGES=10 boundary
    for (let i = 0; i < TARGET_PAGE; i++) {
      mockRequest.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: {
          sessions: [
            {
              ...SECOND_SESSION,
              session_id: `sess_filler_${i}`,
            },
          ],
          next_cursor: `page${i + 1}`,
          has_more: true,
        },
      } satisfies HttpResult);
    }
    // Page TARGET_PAGE — contains target.
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        sessions: [SAMPLE_SESSION],
        next_cursor: null,
        has_more: false,
      },
    } satisfies HttpResult);
    const m = matchResourceTemplate(
      `artifacta://session/${SAMPLE_SESSION.session_id}`
    )!;
    const result = await m.read(
      `artifacta://session/${SAMPLE_SESSION.session_id}`,
      m.params
    );
    expect(JSON.parse((result.contents[0] as { text: string }).text)).toEqual(
      SAMPLE_SESSION
    );
    // We made TARGET_PAGE+1 round-trips total.
    expect(mockRequest).toHaveBeenCalledTimes(TARGET_PAGE + 1);
    // Each successive request carried the prior page's cursor as `after`.
    expect(getRequestedQuery(1).get("after")).toBe("page1");
    expect(getRequestedQuery(TARGET_PAGE).get("after")).toBe(
      `page${TARGET_PAGE}`
    );
  });

  it("returns §6 session_not_found ONLY when the API confirms has_more:false without a match", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { sessions: [], next_cursor: null, has_more: false },
    } satisfies HttpResult);
    const m = matchResourceTemplate("artifacta://session/sess_missing")!;
    await expect(
      m.read("artifacta://session/sess_missing", m.params)
    ).rejects.toMatchObject({
      message: expect.stringContaining(
        "No artifacts exist for session sess_missing"
      ),
    });
  });

  it("treats a missing next_cursor with has_more:true as definitive not-found (defensive)", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { sessions: [SECOND_SESSION], next_cursor: null, has_more: true },
    } satisfies HttpResult);
    const m = matchResourceTemplate("artifacta://session/sess_missing")!;
    // Without a cursor we can't continue; fall through to not-found rather
    // than spin in an infinite loop.
    await expect(
      m.read("artifacta://session/sess_missing", m.params)
    ).rejects.toMatchObject({
      message: expect.stringContaining(
        "No artifacts exist for session sess_missing"
      ),
    });
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it("safety cap fires DISTINCTLY from session_not_found when /v1/sessions never terminates", async () => {
    // Simulate an API stuck reporting has_more=true forever (pagination bug
    // or runaway loop). The walker MUST stop and surface a distinct error
    // so the agent recognizes "search exhausted" vs "session does not
    // exist" — Codex finding 2026-05-08.
    mockRequest.mockImplementation(async () => ({
      ok: true,
      status: 200,
      data: {
        sessions: [SECOND_SESSION],
        next_cursor: "another-page",
        has_more: true,
      },
    }));
    const m = matchResourceTemplate("artifacta://session/sess_unreachable")!;
    await expect(
      m.read("artifacta://session/sess_unreachable", m.params)
    ).rejects.toMatchObject({
      message: expect.stringMatching(/search exhausted/),
    });
    // The error MUST NOT use the session_not_found phrasing — that's the
    // whole point of distinguishing the two failure modes.
    await m
      .read("artifacta://session/sess_unreachable", m.params)
      .catch((err: Error) => {
        expect(err.message).not.toContain("No artifacts exist for session");
        // Should mention list_artifacts as the recommended fallback.
        expect(err.message).toContain("list_artifacts");
        expect(err.message).toContain("sess_unreachable");
      });
  });

  it("propagates upstream errors as McpError with translated text", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: false,
      status: 401,
      error: { code: "unauthorized", message: "bad key", status: 401 },
      attempts: 1,
    } satisfies HttpResult);
    const m = matchResourceTemplate("artifacta://session/sess_x")!;
    await expect(
      m.read("artifacta://session/sess_x", m.params)
    ).rejects.toMatchObject({
      message: expect.stringContaining("Artifacta authentication failed"),
    });
  });
});
