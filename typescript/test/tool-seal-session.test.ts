// AF_MCP-4.2 — seal_session tool (destructive — gated, irreversible).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  SEAL_SESSION_DESCRIPTION,
  SEAL_SESSION_TOOL,
  sealSessionHandler,
  registerSealSessionTool,
} from "../src/tools/seal-session.js";
import { resetHttpClient, setHttpClient } from "../src/http/instance.js";
import {
  clearRegistry,
  getToolRegistration,
  getFilteredTools,
  isCallPermitted,
} from "../src/safety/registry.js";
import { parseSafetyFlags } from "../src/safety/flags.js";
import { emitDestructiveAudit } from "../src/safety/audit.js";
import { compileToolSchema, checkToolSchemaContract } from "./_helpers/ajv.js";
import type { ArtifactaHttpClient } from "../src/http/client.js";
import type { HttpResult } from "../src/http/types.js";

const VALID_SESSION = "training-run-2026-05-27";

const SEAL_SUCCESS = {
  session_id: VALID_SESSION,
  status: "sealed" as const,
  sealed_at: "2026-05-27T15:42:00+00:00",
  artifact_count: 3,
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
  registerSealSessionTool();
});

afterEach(() => {
  clearRegistry();
  resetHttpClient();
  delete process.env.ALLOW_DESTRUCTIVE;
  delete process.env.ARTIFACTA_MCP_ALLOW_DESTRUCTIVE;
  delete process.env.ARTIFACTA_MCP_REQUIRE_WRITE_CONFIRM;
  vi.restoreAllMocks();
});

// ─── Registration + schema ───────────────────────────────────────────────────

describe("AF_MCP-4.2 — seal_session registration", () => {
  it("registers tool name 'seal_session' with safety 'destructive'", () => {
    const reg = getToolRegistration("seal_session");
    expect(reg).toBeDefined();
    expect(reg!.tool.name).toBe("seal_session");
    expect(reg!.safety).toBe("destructive");
  });

  it("alwaysConfirm is NOT set (safety 'destructive' alone forces confirmation)", () => {
    const reg = getToolRegistration("seal_session");
    expect(reg!.alwaysConfirm).toBe(false);
  });

  it("tool.description === SEAL_SESSION_DESCRIPTION constant", () => {
    expect(SEAL_SESSION_TOOL.description).toBe(SEAL_SESSION_DESCRIPTION);
  });

  it("description is plan §2.11 verbatim (preserves **bold** irreversible)", () => {
    expect(SEAL_SESSION_DESCRIPTION).toBe(
      "Permanently prevent further artifacts from being added to a session. Existing artifacts remain readable and downloadable. Sealing a session is **irreversible** — there is no `unseal` endpoint. Use this only when an agent's pipeline has confirmed completion and you want to harden the session against late-write corruption."
    );
  });

  it("AF_MCP-4.2.16: description contains 'irreversible' and 'unseal' note", () => {
    // The bold markdown is `**irreversible**` so the substring assertion is on
    // the bare word; the verbatim test above pins the bold form.
    expect(SEAL_SESSION_DESCRIPTION).toContain("**irreversible**");
    expect(SEAL_SESSION_DESCRIPTION).toContain("`unseal` endpoint");
  });

  it("input schema satisfies the structural MCP contract", () => {
    expect(checkToolSchemaContract(SEAL_SESSION_TOOL)).toEqual([]);
  });

  it("input schema: single required session_id with minLength: 1 (§2.11)", () => {
    const s = SEAL_SESSION_TOOL.inputSchema as Record<string, unknown>;
    expect(s.required).toEqual(["session_id"]);
    expect(s.additionalProperties).toBe(false);
    const props = s.properties as Record<string, Record<string, unknown>>;
    expect(props.session_id.type).toBe("string");
    expect(props.session_id.minLength).toBe(1);
  });
});

// ─── Schema validation gate ──────────────────────────────────────────────────

describe("AF_MCP-4.2 — schema validation gate", () => {
  it("accepts a non-empty session_id", () => {
    const validate = compileToolSchema(SEAL_SESSION_TOOL);
    expect(validate({ session_id: VALID_SESSION })).toBe(true);
  });

  it("AF_MCP-4.2.13: empty session_id rejected (minLength: 1)", () => {
    const validate = compileToolSchema(SEAL_SESSION_TOOL);
    expect(validate({ session_id: "" })).toBe(false);
  });

  it("AF_MCP-4.2.17: additionalProperties rejected", () => {
    const validate = compileToolSchema(SEAL_SESSION_TOOL);
    expect(validate({ session_id: VALID_SESSION, extra: 1 })).toBe(false);
  });

  it("rejects payload missing session_id", () => {
    const validate = compileToolSchema(SEAL_SESSION_TOOL);
    expect(validate({})).toBe(false);
  });

  it("rejects non-string session_id", () => {
    const validate = compileToolSchema(SEAL_SESSION_TOOL);
    expect(validate({ session_id: 123 })).toBe(false);
  });
});

// ─── Gating: tools/list filter behavior ──────────────────────────────────────

describe("AF_MCP-4.2 — gating in tools/list", () => {
  it("AF_MCP-4.2.01: compliant client → tool present with requiresConfirmation: true", () => {
    const tools = getFilteredTools({
      hasConfirmations: true,
      allowDestructive: false,
      writeConfirmRequired: false,
    });
    const entry = tools.find((t) => t.name === "seal_session");
    expect(entry).toBeDefined();
    const meta = entry!._meta as { requiresConfirmation?: boolean } | undefined;
    expect(meta?.requiresConfirmation).toBe(true);
  });

  it("AF_MCP-4.2.02: non-compliant client without --allow-destructive → tool absent", () => {
    const tools = getFilteredTools({
      hasConfirmations: false,
      allowDestructive: false,
      writeConfirmRequired: false,
    });
    expect(tools.find((t) => t.name === "seal_session")).toBeUndefined();
  });

  it("AF_MCP-4.2.03: non-compliant + --allow-destructive → tool present", () => {
    const tools = getFilteredTools({
      hasConfirmations: false,
      allowDestructive: true,
      writeConfirmRequired: false,
    });
    const entry = tools.find((t) => t.name === "seal_session");
    expect(entry).toBeDefined();
    const meta = entry!._meta as { requiresConfirmation?: boolean } | undefined;
    expect(meta?.requiresConfirmation).toBeUndefined();
  });

  it("call dispatch gate: non-compliant + no --allow-destructive → isCallPermitted false", () => {
    const reg = getToolRegistration("seal_session")!;
    expect(isCallPermitted(reg, false, false)).toBe(false);
  });

  it("call dispatch gate: --allow-destructive permits direct call on non-compliant client", () => {
    const reg = getToolRegistration("seal_session")!;
    expect(isCallPermitted(reg, false, true)).toBe(true);
  });

  it("call dispatch gate: compliant client permits direct call", () => {
    const reg = getToolRegistration("seal_session")!;
    expect(isCallPermitted(reg, true, false)).toBe(true);
  });
});

// ─── --allow-destructive flag-only source (AF_MCP-4.2.14) ────────────────────

describe("AF_MCP-4.2 — --allow-destructive is flag-only (never env)", () => {
  it("AF_MCP-4.2.14: ALLOW_DESTRUCTIVE env var does NOT expose the tool", () => {
    process.env.ALLOW_DESTRUCTIVE = "1";
    process.env.ARTIFACTA_MCP_ALLOW_DESTRUCTIVE = "1";
    const flags = parseSafetyFlags([]);
    expect(flags.allowDestructive).toBe(false);
    const tools = getFilteredTools({
      hasConfirmations: false,
      allowDestructive: flags.allowDestructive,
      writeConfirmRequired: false,
    });
    expect(tools.find((t) => t.name === "seal_session")).toBeUndefined();
  });
});

// ─── Stderr audit (AF_MCP-4.2.04) ────────────────────────────────────────────

describe("AF_MCP-4.2 — stderr audit line", () => {
  let chunks: string[];
  let originalWrite: typeof process.stderr.write;

  beforeEach(() => {
    chunks = [];
    originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
  });

  it("AF_MCP-4.2.04: emitDestructiveAudit fires the §5 stderr line for seal_session", () => {
    emitDestructiveAudit("seal_session", { session_id: VALID_SESSION });
    const joined = chunks.join("");
    expect(joined).toContain(
      "[artifacta-mcp] destructive call: seal_session("
    );
    expect(joined).toContain("— no confirmation surface");
    expect(joined).toContain(`"session_id":"${VALID_SESSION}"`);
  });
});

// ─── Handler — happy path ────────────────────────────────────────────────────

describe("AF_MCP-4.2 — seal_session handler (success)", () => {
  it("AF_MCP-4.2.05/06/07/08: success → POST /v1/sessions/{id}/seal; returns session_id + status:'sealed' + sealed_at + artifact_count", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: SEAL_SUCCESS,
    } satisfies HttpResult);

    const result = await sealSessionHandler({ session_id: VALID_SESSION });
    expect(result.isError).toBeUndefined();
    expect(mockRequest).toHaveBeenCalledOnce();

    const opts = mockRequest.mock.calls[0][0] as {
      method: string;
      path: string;
      retryPolicy: string;
    };
    expect(opts.method).toBe("POST");
    expect(opts.path).toBe(`/v1/sessions/${encodeURIComponent(VALID_SESSION)}/seal`);
    expect(opts.retryPolicy).toBe("idempotentWrite");

    const parsed = JSON.parse(
      (result.content[0] as { text: string }).text
    ) as Record<string, unknown>;
    expect(parsed.session_id).toBe(VALID_SESSION);
    expect(parsed.status).toBe("sealed");
    expect(typeof parsed.sealed_at).toBe("string");
    // ISO 8601-ish — parseable by Date
    expect(Number.isNaN(Date.parse(parsed.sealed_at as string))).toBe(false);
    expect(parsed.artifact_count).toBe(3);
  });

  it("does NOT inject a caller idempotency key (none needed — naturally idempotent)", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: SEAL_SUCCESS,
    } satisfies HttpResult);
    await sealSessionHandler({ session_id: VALID_SESSION });
    const opts = mockRequest.mock.calls[0][0] as {
      callerIdempotencyKey?: string;
      body?: unknown;
    };
    expect(opts.callerIdempotencyKey).toBeUndefined();
    expect(opts.body).toBeUndefined();
  });

  it("encodes session_id as a URL path segment (encodeURIComponent applied as defense-in-depth)", async () => {
    // SESSION_ID_PATTERN already rejects every char encodeURIComponent would
    // need to encode (slash, space, ?, #, %, &, =, +, :, control, Unicode), so
    // for any valid session_id the encoded form == the raw form. This test
    // pins that encodeURIComponent is still on the path — defense-in-depth in
    // case the schema is ever loosened.
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: SEAL_SUCCESS,
    } satisfies HttpResult);
    await sealSessionHandler({ session_id: VALID_SESSION });
    const opts = mockRequest.mock.calls[0][0] as { path: string };
    expect(opts.path).toBe(`/v1/sessions/${encodeURIComponent(VALID_SESSION)}/seal`);
  });
});

// ─── SESSION_ID_PATTERN regression suite (Codex finding 2026-05-27) ──────────
//
// The plan §2.11 input schema was {session_id: string, minLength: 1} only. An
// adversarial review (codex:adversarial-review against HEAD~2) flagged that
// FastAPI's default path converter decodes %2F back to / before route
// matching, so a session_id like `run/42` (which the upload endpoints
// accepted as free-form text) becomes unsealable: POST /v1/sessions/run%2F42
// /seal → routes to /sessions/run/42/seal → 404. The MCP boundary now
// constrains session_id to SESSION_ID_PATTERN so the server cannot mint a
// shape it cannot address. The upload-side constraint lives in
// store-artifact.ts and request-upload-url.ts.

describe("AF_MCP-4.2 — SESSION_ID_PATTERN (Codex finding regression)", () => {
  // Schema-gate cases: assert the JSON schema accepts spec-shaped session ids
  // and rejects path-unsafe shapes BEFORE the handler is invoked.
  describe("schema-level accept/reject", () => {
    const accepted = [
      "pipeline_run_42", // spec example
      "daily_batch_20260313", // spec example
      "run-42", // spec example
      "experiment-v3", // spec example
      "ses_abc123def456", // SDK auto-generated format
      "a", // single-char minimum
      "Run.Stage.2026-05-27", // dotted + mixed-case + hyphen
      "A".repeat(128), // max length
    ];
    const rejected: Array<[string, string]> = [
      ["run/42", "Codex finding — slash breaks FastAPI path matching"],
      ["a/b c", "slash + space"],
      ["run with space", "literal space"],
      ["run?42", "URL query separator"],
      ["run#42", "URL fragment separator"],
      ["run%42", "URL percent literal"],
      ["run&id=1", "URL params"],
      [".hidden", "leading dot (filesystem-hidden convention)"],
      ["-leading-dash", "leading dash"],
      ["_leading_underscore", "leading underscore"],
      ["run\x00null", "embedded null byte"],
      ["run🔥hot", "Unicode"],
      ["A".repeat(129), "exceeds 128-char limit"],
    ];

    it.each(accepted)("schema accepts %s", (s) => {
      const validate = compileToolSchema(SEAL_SESSION_TOOL);
      expect(validate({ session_id: s })).toBe(true);
    });

    it.each(rejected)("schema rejects %s (%s)", (s, _reason) => {
      const validate = compileToolSchema(SEAL_SESSION_TOOL);
      expect(validate({ session_id: s })).toBe(false);
    });
  });

  // Runtime-gate cases: the SDK does NOT validate inputSchema before dispatch,
  // so the handler itself must refuse path-unsafe session_ids before any HTTP
  // call. This proves the bug is closed even against non-compliant clients.
  describe("runtime guard (defensive — bypasses SDK schema check)", () => {
    it("Codex case: session_id 'run/42' → invalid_request, API NEVER called", async () => {
      const result = await sealSessionHandler({ session_id: "run/42" });
      expect(result.isError).toBe(true);
      expect(mockRequest).not.toHaveBeenCalled();
      const meta = result._meta as Record<string, unknown> | undefined;
      expect(meta?.code).toBe("invalid_request");
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("[A-Za-z0-9._-]");
    });

    it("space-containing session_id → invalid_request, API not called", async () => {
      const result = await sealSessionHandler({ session_id: "run 42" });
      expect(result.isError).toBe(true);
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it("leading-dot session_id → invalid_request, API not called", async () => {
      const result = await sealSessionHandler({ session_id: ".hidden" });
      expect(result.isError).toBe(true);
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it("Unicode session_id → invalid_request, API not called", async () => {
      const result = await sealSessionHandler({ session_id: "run🔥" });
      expect(result.isError).toBe(true);
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it("over-length session_id (129 chars) → invalid_request, API not called", async () => {
      const result = await sealSessionHandler({ session_id: "A".repeat(129) });
      expect(result.isError).toBe(true);
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it("SDK auto-format `ses_<12-alnum>` passes the runtime gate", async () => {
      mockRequest.mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { ...SEAL_SUCCESS, session_id: "ses_abc123def456" },
      } satisfies HttpResult);
      const result = await sealSessionHandler({ session_id: "ses_abc123def456" });
      expect(result.isError).toBeUndefined();
      expect(mockRequest).toHaveBeenCalledOnce();
    });
  });
});

// ─── Idempotent replay (AF_MCP-4.2.10) ───────────────────────────────────────

describe("AF_MCP-4.2 — idempotent replay (re-seal)", () => {
  it("AF_MCP-4.2.10: two consecutive calls return same seal info (API is naturally idempotent)", async () => {
    // Re-seal returns the same row (sealed_at unchanged) per the shared
    // seal_session PG function. The MCP layer is a passthrough — no special
    // success-on-replay logic is needed.
    mockRequest
      .mockResolvedValueOnce({ ok: true, status: 200, data: SEAL_SUCCESS } satisfies HttpResult)
      .mockResolvedValueOnce({ ok: true, status: 200, data: SEAL_SUCCESS } satisfies HttpResult);

    const first = await sealSessionHandler({ session_id: VALID_SESSION });
    const second = await sealSessionHandler({ session_id: VALID_SESSION });
    expect(first.isError).toBeUndefined();
    expect(second.isError).toBeUndefined();
    expect((first.content[0] as { text: string }).text).toBe(
      (second.content[0] as { text: string }).text
    );
  });
});

// ─── Error translation (AF_MCP-4.2.11 / 4.2.12) ──────────────────────────────

describe("AF_MCP-4.2 — error translation", () => {
  it("AF_MCP-4.2.11: session_not_found translated with §6 text + filled id", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: {
        code: "session_not_found",
        message: `No artifacts found for session '${VALID_SESSION}'.`,
        status: 404,
      },
      attempts: 1,
    } satisfies HttpResult);

    const result = await sealSessionHandler({ session_id: VALID_SESSION });
    expect(result.isError).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.code).toBe("session_not_found");
    expect(meta?.retry_hint).toBe("do_not_retry");

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain(VALID_SESSION);
    expect(text).toContain("Sessions are synthesized from artifacts");
  });

  it("AF_MCP-4.2.12: session with no artifacts returns session_not_found (per AF_CLI-2.1)", async () => {
    // Per api/app/routers/sessions.py:131-136, a session id that never had
    // artifacts raises session_not_found — the MCP layer surfaces it
    // identically to a typo'd id.
    mockRequest.mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: {
        code: "session_not_found",
        message: "No artifacts found for session 'unused-session-id'.",
        status: 404,
      },
      attempts: 1,
    } satisfies HttpResult);

    const result = await sealSessionHandler({ session_id: "unused-session-id" });
    expect(result.isError).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.code).toBe("session_not_found");
  });

  it("unauthorized (401) translated with §4.3 remediation text", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: false,
      status: 401,
      error: {
        code: "unauthorized",
        message: "Invalid API key.",
        status: 401,
      },
      attempts: 1,
    } satisfies HttpResult);

    const result = await sealSessionHandler({ session_id: VALID_SESSION });
    expect(result.isError).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.code).toBe("unauthorized");
  });
});

// ─── Auto-retry policy (AF_MCP-4.2.15) ───────────────────────────────────────

describe("AF_MCP-4.2 — auto-retry policy", () => {
  it("AF_MCP-4.2.15: uses idempotentWrite policy (429 once + 5xx up to 3× at the wire)", async () => {
    // The fake client returns the failure directly. We assert the tool wires
    // retryPolicy "idempotentWrite", which enables 429-once + 5xx-up-to-3×
    // behavior at the HTTP layer. The wire-level multi-call retry is proven
    // in http-client.test.ts ("idempotentWrite: retries 5xx up to 3 times").
    mockRequest.mockResolvedValueOnce({
      ok: false,
      status: 502,
      error: { code: "server_error", message: "bad gateway", status: 502 },
      attempts: 4,
    } satisfies HttpResult);

    const result = await sealSessionHandler({ session_id: VALID_SESSION });
    expect(result.isError).toBe(true);
    const opts = mockRequest.mock.calls[0][0] as { retryPolicy: string };
    expect(opts.retryPolicy).toBe("idempotentWrite");
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.retry_hint).toBe("retry_with_backoff");
  });
});

// ─── Defensive runtime validation (SDK does not pre-validate inputSchema) ────

describe("AF_MCP-4.2 — defensive runtime validation", () => {
  it("missing session_id → local invalid_request, API not called", async () => {
    const result = await sealSessionHandler({});
    expect(result.isError).toBe(true);
    expect(mockRequest).not.toHaveBeenCalled();
    expect((result._meta as Record<string, unknown>).code).toBe("invalid_request");
  });

  it("empty session_id → local invalid_request, API not called", async () => {
    const result = await sealSessionHandler({ session_id: "" });
    expect(result.isError).toBe(true);
    expect(mockRequest).not.toHaveBeenCalled();
    expect((result._meta as Record<string, unknown>).code).toBe("invalid_request");
  });

  it("non-string session_id → local invalid_request, API not called", async () => {
    const result = await sealSessionHandler({
      session_id: 123 as unknown as string,
    });
    expect(result.isError).toBe(true);
    expect(mockRequest).not.toHaveBeenCalled();
    expect((result._meta as Record<string, unknown>).code).toBe("invalid_request");
  });
});
