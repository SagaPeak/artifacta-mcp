// AF_MCP-3.2 — request_upload_url tool (Pro tier gate, no 5xx auto-retry).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  REQUEST_UPLOAD_URL_DESCRIPTION,
  REQUEST_UPLOAD_URL_TOOL,
  requestUploadUrlHandler,
  registerRequestUploadUrlTool,
} from "../src/tools/request-upload-url.js";
import { resetHttpClient, setHttpClient } from "../src/http/instance.js";
import { clearRegistry, getToolRegistration } from "../src/safety/registry.js";
import { compileToolSchema, checkToolSchemaContract } from "./_helpers/ajv.js";
import type { ArtifactaHttpClient } from "../src/http/client.js";
import type { HttpResult } from "../src/http/types.js";

const MAX_SIZE_BYTES = 5368709120; // 5 GB

const SUCCESS_BODY = {
  artifact_id: "art_AAAAAAAAAAAAAAAA",
  status: "pending",
  upload_url:
    "https://r2.example.io/blob/tenant_x/pending/model.bin?X-Amz-Signature=...",
  upload_expires_at: "2026-05-25T13:00:00+00:00",
  upload_method: "PUT",
  upload_headers: { "Content-Type": "application/octet-stream" },
};

const VALID_ARGS = {
  filename: "model.bin",
  content_type: "application/octet-stream",
  size_bytes: 1_000_000,
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
  registerRequestUploadUrlTool();
});

afterEach(() => {
  clearRegistry();
  resetHttpClient();
  vi.restoreAllMocks();
});

// ─── Registration + schema ───────────────────────────────────────────────────

describe("AF_MCP-3.2 — request_upload_url registration", () => {
  it("registers tool name 'request_upload_url' with safety 'writeNonIdempotent'", () => {
    const reg = getToolRegistration("request_upload_url");
    expect(reg).toBeDefined();
    expect(reg!.tool.name).toBe("request_upload_url");
    expect(reg!.safety).toBe("writeNonIdempotent");
  });

  it("is NOT alwaysConfirm (default autonomous per §5.2 — overridable via env var)", () => {
    const reg = getToolRegistration("request_upload_url");
    expect(reg!.alwaysConfirm).toBe(false);
  });

  it("tool.description === REQUEST_UPLOAD_URL_DESCRIPTION constant", () => {
    expect(REQUEST_UPLOAD_URL_TOOL.description).toBe(REQUEST_UPLOAD_URL_DESCRIPTION);
  });

  it("input schema satisfies the structural MCP contract", () => {
    expect(checkToolSchemaContract(REQUEST_UPLOAD_URL_TOOL)).toEqual([]);
  });

  it("requires filename, content_type, size_bytes (§2.6)", () => {
    const s = REQUEST_UPLOAD_URL_TOOL.inputSchema as Record<string, unknown>;
    expect(s.required).toEqual(["filename", "content_type", "size_bytes"]);
    expect(s.additionalProperties).toBe(false);
  });

  it("size_bytes schema pins minimum 1 and maximum 5 GB (§2.6)", () => {
    const s = REQUEST_UPLOAD_URL_TOOL.inputSchema as Record<string, unknown>;
    const props = s.properties as Record<string, Record<string, unknown>>;
    expect(props.size_bytes.type).toBe("integer");
    expect(props.size_bytes.minimum).toBe(1);
    expect(props.size_bytes.maximum).toBe(MAX_SIZE_BYTES);
  });
});

// ─── Description (AF_MCP-3.2.12) ──────────────────────────────────────────────

describe("AF_MCP-3.2 — description (LLM-facing contract)", () => {
  it("AF_MCP-3.2.12: steers toward store_artifact for files ≤500 MB", () => {
    expect(REQUEST_UPLOAD_URL_DESCRIPTION).toContain("store_artifact");
    // §2.6 verbatim steering: "too large to send through store_artifact (over 500 MB ...)"
    expect(REQUEST_UPLOAD_URL_DESCRIPTION).toContain("over 500 MB");
    expect(REQUEST_UPLOAD_URL_DESCRIPTION).toMatch(
      /Most agents should use `store_artifact`/
    );
  });

  it("mentions the Pro-only restriction", () => {
    expect(REQUEST_UPLOAD_URL_DESCRIPTION).toMatch(/Pro plan only/);
  });

  it("warns about ambiguous-completion semantics (AC #7)", () => {
    expect(REQUEST_UPLOAD_URL_DESCRIPTION.toLowerCase()).toContain("not retry-safe");
    expect(REQUEST_UPLOAD_URL_DESCRIPTION).toContain("list_artifacts");
  });
});

// ─── Schema validation gate ──────────────────────────────────────────────────

describe("AF_MCP-3.2 — schema validation gate", () => {
  it("accepts a valid minimal payload", () => {
    const validate = compileToolSchema(REQUEST_UPLOAD_URL_TOOL);
    expect(validate(VALID_ARGS)).toBe(true);
  });

  it("AF_MCP-3.2.05: size_bytes = 5 GB (boundary) accepted", () => {
    const validate = compileToolSchema(REQUEST_UPLOAD_URL_TOOL);
    expect(
      validate({ ...VALID_ARGS, size_bytes: MAX_SIZE_BYTES })
    ).toBe(true);
  });

  it("AF_MCP-3.2.06: size_bytes = 0 rejected at schema", () => {
    const validate = compileToolSchema(REQUEST_UPLOAD_URL_TOOL);
    expect(validate({ ...VALID_ARGS, size_bytes: 0 })).toBe(false);
  });

  it("AF_MCP-3.2.07: size_bytes > 5 GB rejected at schema", () => {
    const validate = compileToolSchema(REQUEST_UPLOAD_URL_TOOL);
    expect(
      validate({ ...VALID_ARGS, size_bytes: MAX_SIZE_BYTES + 1 })
    ).toBe(false);
  });

  it("rejects a non-integer size_bytes", () => {
    const validate = compileToolSchema(REQUEST_UPLOAD_URL_TOOL);
    expect(validate({ ...VALID_ARGS, size_bytes: 1.5 })).toBe(false);
  });

  it("AF_MCP-3.2.11: additionalProperties rejected", () => {
    const validate = compileToolSchema(REQUEST_UPLOAD_URL_TOOL);
    expect(validate({ ...VALID_ARGS, extra: "nope" })).toBe(false);
  });

  it("rejects a payload missing content_type", () => {
    const validate = compileToolSchema(REQUEST_UPLOAD_URL_TOOL);
    expect(validate({ filename: "f", size_bytes: 100 })).toBe(false);
  });

  it("rejects an invalid metadata key (leading dot)", () => {
    const validate = compileToolSchema(REQUEST_UPLOAD_URL_TOOL);
    expect(
      validate({ ...VALID_ARGS, metadata: { ".bad": "v" } })
    ).toBe(false);
  });
});

// ─── Handler — happy path ────────────────────────────────────────────────────

describe("AF_MCP-3.2 — request_upload_url handler (success)", () => {
  it("AF_MCP-3.2.01: Pro tenant → POST /v1/artifacts/upload-url, returns presigned URL", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: SUCCESS_BODY,
    } satisfies HttpResult);

    const result = await requestUploadUrlHandler(VALID_ARGS);
    expect(result.isError).toBeUndefined();
    expect(mockRequest).toHaveBeenCalledOnce();

    const opts = mockRequest.mock.calls[0][0] as {
      method: string;
      path: string;
      retryPolicy: string;
      body: Record<string, unknown>;
    };
    expect(opts.method).toBe("POST");
    expect(opts.path).toBe("/v1/artifacts/upload-url");
    expect(opts.body.filename).toBe("model.bin");
    expect(opts.body.content_type).toBe("application/octet-stream");
    expect(opts.body.size_bytes).toBe(1_000_000);

    const parsed = JSON.parse(
      (result.content[0] as { text: string }).text
    ) as Record<string, unknown>;
    expect(parsed).toEqual(SUCCESS_BODY);
    expect(parsed.artifact_id).toBe("art_AAAAAAAAAAAAAAAA");
    expect(parsed.upload_url).toBe(SUCCESS_BODY.upload_url);
    expect(parsed.upload_headers).toEqual(SUCCESS_BODY.upload_headers);
  });

  it("AF_MCP-3.2.02: response surfaces upload_method 'PUT'", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: SUCCESS_BODY,
    } satisfies HttpResult);
    const result = await requestUploadUrlHandler(VALID_ARGS);
    const parsed = JSON.parse(
      (result.content[0] as { text: string }).text
    ) as { upload_method: string };
    expect(parsed.upload_method).toBe("PUT");
  });

  it("AF_MCP-3.2.03: response surfaces status 'pending'", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: SUCCESS_BODY,
    } satisfies HttpResult);
    const result = await requestUploadUrlHandler(VALID_ARGS);
    const parsed = JSON.parse(
      (result.content[0] as { text: string }).text
    ) as { status: string };
    expect(parsed.status).toBe("pending");
  });

  it("AF_MCP-3.2.13: optional session_id / agent_id / ttl / metadata forwarded in body", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: SUCCESS_BODY,
    } satisfies HttpResult);
    await requestUploadUrlHandler({
      ...VALID_ARGS,
      session_id: "sess-123",
      agent_id: "agent-x",
      ttl: "30d",
      metadata: { run_id: "r1" },
    });
    const opts = mockRequest.mock.calls[0][0] as {
      body: Record<string, unknown>;
    };
    expect(opts.body.session_id).toBe("sess-123");
    expect(opts.body.agent_id).toBe("agent-x");
    expect(opts.body.ttl).toBe("30d");
    expect(opts.body.metadata).toEqual({ run_id: "r1" });
  });

  it("omits optional fields from the body when not provided", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: SUCCESS_BODY,
    } satisfies HttpResult);
    await requestUploadUrlHandler(VALID_ARGS);
    const opts = mockRequest.mock.calls[0][0] as {
      body: Record<string, unknown>;
    };
    expect("session_id" in opts.body).toBe(false);
    expect("agent_id" in opts.body).toBe(false);
    expect("ttl" in opts.body).toBe(false);
    expect("metadata" in opts.body).toBe(false);
  });
});

// ─── Handler — Pro tier gate (AF_MCP-3.2.04) ─────────────────────────────────

describe("AF_MCP-3.2 — Free tier gate", () => {
  it("AF_MCP-3.2.04: Free tenant → translated quota_exceeded with upgrade message", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: false,
      status: 403,
      error: {
        code: "quota_exceeded",
        message: "Presigned uploads require a Pro plan. Upgrade at https://app.artifacta.io/dashboard/billing",
        status: 403,
        upgrade_url: "https://app.artifacta.io/dashboard/billing",
      },
      attempts: 1,
    } satisfies HttpResult);

    const result = await requestUploadUrlHandler(VALID_ARGS);
    expect(result.isError).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.code).toBe("quota_exceeded");
    expect(meta?.retry_hint).toBe("do_not_retry");
    expect(meta?.upgrade_url).toBe("https://app.artifacta.io/dashboard/billing");

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Plan quota exceeded");
    expect(text).toContain("Presigned uploads require a Pro plan");
    expect(text).toContain("https://app.artifacta.io/dashboard/billing");
  });
});

// ─── Handler — 5xx / no auto-retry / ambiguous completion ────────────────────

describe("AF_MCP-3.2 — non-idempotent 5xx handling", () => {
  it("AF_MCP-3.2.08: 5xx → no auto-retry; tool makes exactly 1 HTTP call with nonIdempotentWrite policy", async () => {
    // The fake client returns the failure directly (it does not implement the
    // retry loop). Asserting exactly-one-call proves the TOOL never loops, and
    // the retryPolicy assertion proves the no-retry-on-5xx contract is wired.
    // The wire-level proof that nonIdempotentWrite makes exactly one HTTP call
    // on a real 502 lives in http-client.test.ts ("request_upload_url 502 does
    // NOT trigger retry", ~line 222).
    mockRequest.mockResolvedValueOnce({
      ok: false,
      status: 502,
      error: { code: "server_error", message: "bad gateway", status: 502 },
      attempts: 1,
      ambiguousCompletion: true,
    } satisfies HttpResult);

    const result = await requestUploadUrlHandler(VALID_ARGS);
    expect(result.isError).toBe(true);
    expect(mockRequest).toHaveBeenCalledOnce();
    const opts = mockRequest.mock.calls[0][0] as { retryPolicy: string };
    expect(opts.retryPolicy).toBe("nonIdempotentWrite");
  });

  it("AF_MCP-3.2.09: 5xx error text contains the verbatim §6.1 ambiguous-completion guidance", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: false,
      status: 502,
      error: { code: "server_error", message: "bad gateway", status: 502 },
      attempts: 1,
      ambiguousCompletion: true,
    } satisfies HttpResult);

    const result = await requestUploadUrlHandler(VALID_ARGS);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain(
      "Artifacta API failed mid-write on request_upload_url"
    );
    expect(text).toContain(
      "call list_artifacts with the same session_id/agent_id and a recent created_after"
    );
    expect(text).toContain("Retrying without checking risks creating a duplicate");

    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.retry_hint).toBe("do_not_retry");
  });

  it("network error also surfaces ambiguous-completion guidance (no retry)", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: false,
      status: 0,
      error: { code: "network_error", message: "ECONNRESET", status: 0 },
      attempts: 1,
      ambiguousCompletion: true,
    } satisfies HttpResult);
    const result = await requestUploadUrlHandler(VALID_ARGS);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("failed mid-write on request_upload_url");
  });
});

// ─── Handler — no Idempotency-Key (AF_MCP-3.2.10) ────────────────────────────

describe("AF_MCP-3.2 — no Idempotency-Key", () => {
  it("AF_MCP-3.2.10: tool never sets callerIdempotencyKey (no key injected on the wire)", async () => {
    // The HTTP client gates auto-injection to POST /v1/artifacts only, and this
    // tool sets no callerIdempotencyKey — so no Idempotency-Key reaches the
    // upload-url endpoint. Wire-level proof: http-client.test.ts ("does NOT
    // inject Idempotency-Key for POST /v1/artifacts/upload-url", ~line 96).
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: SUCCESS_BODY,
    } satisfies HttpResult);
    await requestUploadUrlHandler(VALID_ARGS);
    const opts = mockRequest.mock.calls[0][0] as {
      callerIdempotencyKey?: string;
    };
    expect(opts.callerIdempotencyKey).toBeUndefined();
  });
});

// ─── Handler — defensive runtime validation (SDK does not pre-validate) ───────

describe("AF_MCP-3.2 — defensive runtime validation", () => {
  it("missing filename → local invalid_request, API not called", async () => {
    const result = await requestUploadUrlHandler({
      content_type: "text/plain",
      size_bytes: 100,
    });
    expect(result.isError).toBe(true);
    expect(mockRequest).not.toHaveBeenCalled();
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.code).toBe("invalid_request");
  });

  it("missing content_type → local invalid_request, API not called", async () => {
    const result = await requestUploadUrlHandler({
      filename: "f",
      size_bytes: 100,
    });
    expect(result.isError).toBe(true);
    expect(mockRequest).not.toHaveBeenCalled();
    expect((result._meta as Record<string, unknown>).code).toBe("invalid_request");
  });

  it("non-integer size_bytes → local invalid_request, API not called", async () => {
    const result = await requestUploadUrlHandler({
      filename: "f",
      content_type: "text/plain",
      size_bytes: 1.5,
    });
    expect(result.isError).toBe(true);
    expect(mockRequest).not.toHaveBeenCalled();
    expect((result._meta as Record<string, unknown>).code).toBe("invalid_request");
  });

  it("size_bytes over 5 GB → local invalid_request, API not called", async () => {
    const result = await requestUploadUrlHandler({
      filename: "f",
      content_type: "text/plain",
      size_bytes: MAX_SIZE_BYTES + 1,
    });
    expect(result.isError).toBe(true);
    expect(mockRequest).not.toHaveBeenCalled();
    expect((result._meta as Record<string, unknown>).code).toBe("invalid_request");
  });

  it("invalid metadata key at runtime → local invalid_request, API not called", async () => {
    const result = await requestUploadUrlHandler({
      ...VALID_ARGS,
      metadata: { ".bad": "v" } as unknown as Record<string, string>,
    });
    expect(result.isError).toBe(true);
    expect(mockRequest).not.toHaveBeenCalled();
    expect((result._meta as Record<string, unknown>).code).toBe("invalid_request");
  });

  it("non-string session_id at runtime → local invalid_request, API not called", async () => {
    const result = await requestUploadUrlHandler({
      ...VALID_ARGS,
      session_id: 123 as unknown as string,
    });
    expect(result.isError).toBe(true);
    expect(mockRequest).not.toHaveBeenCalled();
    expect((result._meta as Record<string, unknown>).code).toBe("invalid_request");
  });
});

// ─── SESSION_ID_PATTERN regression (Codex finding 2026-05-27) ────────────────
// request_upload_url is a creator path: a session_id sent here is the shape
// seal_session will later need to address. Constrained symmetrically with
// store_artifact and seal_session. See src/ids/formats.ts for rationale.

describe("AF_MCP-3.2 — session_id schema gate", () => {
  const accepted = [
    "pipeline_run_42",
    "ses_abc123def456",
    "experiment-v3",
    "a",
    "A".repeat(128),
  ];
  const rejected = ["run/42", "run 42", ".hidden", "-leading", "run🔥", "A".repeat(129)];

  it.each(accepted)("schema accepts session_id %s", (s) => {
    const validate = compileToolSchema(REQUEST_UPLOAD_URL_TOOL);
    expect(validate({ ...VALID_ARGS, session_id: s })).toBe(true);
  });

  it.each(rejected)("schema rejects session_id %s", (s) => {
    const validate = compileToolSchema(REQUEST_UPLOAD_URL_TOOL);
    expect(validate({ ...VALID_ARGS, session_id: s })).toBe(false);
  });
});

describe("AF_MCP-3.2 — session_id runtime guard (Codex finding)", () => {
  it("slash session_id 'run/42' → invalid_request, API NEVER called", async () => {
    const result = await requestUploadUrlHandler({
      ...VALID_ARGS,
      session_id: "run/42",
    });
    expect(result.isError).toBe(true);
    expect(mockRequest).not.toHaveBeenCalled();
    expect((result._meta as Record<string, unknown>).code).toBe("invalid_request");
  });

  it("space session_id 'run 42' → invalid_request, API not called", async () => {
    const result = await requestUploadUrlHandler({
      ...VALID_ARGS,
      session_id: "run 42",
    });
    expect(result.isError).toBe(true);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("over-length session_id (129 chars) → invalid_request, API not called", async () => {
    const result = await requestUploadUrlHandler({
      ...VALID_ARGS,
      session_id: "a".repeat(129),
    });
    expect(result.isError).toBe(true);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("valid SDK auto-format `ses_<12-alnum>` passes the runtime gate", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: SUCCESS_BODY,
    } satisfies HttpResult);
    const result = await requestUploadUrlHandler({
      ...VALID_ARGS,
      session_id: "ses_abc123def456",
    });
    expect(result.isError).toBeUndefined();
    expect(mockRequest).toHaveBeenCalledOnce();
  });
});
