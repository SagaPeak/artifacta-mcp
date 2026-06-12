// AF_MCP-3.3 — complete_upload tool.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  COMPLETE_UPLOAD_DESCRIPTION,
  COMPLETE_UPLOAD_TOOL,
  completeUploadHandler,
  registerCompleteUploadTool,
} from "../src/tools/complete-upload.js";
import { resetHttpClient, setHttpClient } from "../src/http/instance.js";
import { clearRegistry, getToolRegistration } from "../src/safety/registry.js";
import { compileToolSchema, checkToolSchemaContract } from "./_helpers/ajv.js";
import { ARTIFACT_ID_PATTERN } from "../src/ids/formats.js";
import type { ArtifactaHttpClient } from "../src/http/client.js";
import type { HttpResult } from "../src/http/types.js";

const VALID_ID = "art_AAAAAAAAAAAAAAAA";

// Full artifact record (active) — what the API returns from /complete on success.
const ACTIVE_RECORD = {
  artifact_id: VALID_ID,
  filename: "model.bin",
  content_type: "application/octet-stream",
  size_bytes: 1_073_741_824,
  content_hash: "a".repeat(64),
  session_id: "sess-1",
  agent_id: "agent-x",
  metadata: { run_id: "r1" },
  expires_at: "2026-06-25T00:00:00+00:00",
  created_at: "2026-05-25T00:00:00+00:00",
  status: "active",
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
  registerCompleteUploadTool();
});

afterEach(() => {
  clearRegistry();
  resetHttpClient();
  vi.restoreAllMocks();
});

// ─── Registration + schema ───────────────────────────────────────────────────

describe("AF_MCP-3.3 — complete_upload registration", () => {
  it("registers tool name 'complete_upload' with safety 'writeIdempotent'", () => {
    const reg = getToolRegistration("complete_upload");
    expect(reg).toBeDefined();
    expect(reg!.tool.name).toBe("complete_upload");
    expect(reg!.safety).toBe("writeIdempotent");
  });

  it("is NOT alwaysConfirm (default autonomous per §5.2 — overridable via env var)", () => {
    const reg = getToolRegistration("complete_upload");
    expect(reg!.alwaysConfirm).toBe(false);
  });

  it("tool.description === COMPLETE_UPLOAD_DESCRIPTION constant", () => {
    expect(COMPLETE_UPLOAD_TOOL.description).toBe(COMPLETE_UPLOAD_DESCRIPTION);
  });

  it("description is plan §2.7 verbatim", () => {
    expect(COMPLETE_UPLOAD_DESCRIPTION).toBe(
      "Finalize an artifact previously reserved via `request_upload_url` after the bytes have been PUT to the presigned URL. Server verifies the blob, computes the content hash, transitions the artifact from `pending` to `active`, and increments tenant usage. Calling this on an already-active artifact is idempotent and returns the existing record. Calling before the PUT completes returns `upload_not_found` — wait and retry."
    );
  });

  it("input schema satisfies the structural MCP contract", () => {
    expect(checkToolSchemaContract(COMPLETE_UPLOAD_TOOL)).toEqual([]);
  });

  it("AF_MCP-3.3 input-schema: single required artifact_id pinned to ARTIFACT_ID_PATTERN (§2.7)", () => {
    const s = COMPLETE_UPLOAD_TOOL.inputSchema as Record<string, unknown>;
    expect(s.required).toEqual(["artifact_id"]);
    expect(s.additionalProperties).toBe(false);
    const props = s.properties as Record<string, Record<string, unknown>>;
    expect(props.artifact_id.pattern).toBe(ARTIFACT_ID_PATTERN);
  });
});

// ─── Schema validation gate ──────────────────────────────────────────────────

describe("AF_MCP-3.3 — schema validation gate", () => {
  it("accepts a valid 16-char alnum id", () => {
    const validate = compileToolSchema(COMPLETE_UPLOAD_TOOL);
    expect(validate({ artifact_id: VALID_ID })).toBe(true);
  });

  it("AF_MCP-3.3.08: rejects invalid artifact_id (no prefix)", () => {
    const validate = compileToolSchema(COMPLETE_UPLOAD_TOOL);
    expect(validate({ artifact_id: "invalid" })).toBe(false);
  });

  it("rejects a 15-char id (one short)", () => {
    const validate = compileToolSchema(COMPLETE_UPLOAD_TOOL);
    expect(validate({ artifact_id: "art_123456789012345" })).toBe(false);
  });

  it("AF_MCP-3.3.09: additionalProperties rejected", () => {
    const validate = compileToolSchema(COMPLETE_UPLOAD_TOOL);
    expect(validate({ artifact_id: VALID_ID, extra: 1 })).toBe(false);
  });

  it("rejects payload missing artifact_id", () => {
    const validate = compileToolSchema(COMPLETE_UPLOAD_TOOL);
    expect(validate({})).toBe(false);
  });
});

// ─── Handler — happy path ────────────────────────────────────────────────────

describe("AF_MCP-3.3 — complete_upload handler (success)", () => {
  it("AF_MCP-3.3.01: pending artifact → POST /v1/artifacts/{id}/complete; returns full active record", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: ACTIVE_RECORD,
    } satisfies HttpResult);

    const result = await completeUploadHandler({ artifact_id: VALID_ID });
    expect(result.isError).toBeUndefined();
    expect(mockRequest).toHaveBeenCalledOnce();

    const opts = mockRequest.mock.calls[0][0] as {
      method: string;
      path: string;
      retryPolicy: string;
    };
    expect(opts.method).toBe("POST");
    expect(opts.path).toBe(`/v1/artifacts/${VALID_ID}/complete`);
    expect(opts.retryPolicy).toBe("idempotentWrite");

    const parsed = JSON.parse(
      (result.content[0] as { text: string }).text
    ) as Record<string, unknown>;
    expect(parsed).toEqual(ACTIVE_RECORD);
    expect(parsed.status).toBe("active");
    expect(parsed.content_hash).toBe(ACTIVE_RECORD.content_hash);
  });

  it("does NOT inject a caller idempotency key (none needed — naturally idempotent)", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: ACTIVE_RECORD,
    } satisfies HttpResult);
    await completeUploadHandler({ artifact_id: VALID_ID });
    const opts = mockRequest.mock.calls[0][0] as {
      callerIdempotencyKey?: string;
    };
    expect(opts.callerIdempotencyKey).toBeUndefined();
  });

  it("AF_MCP-3.3.03: second call returns the same record without error (idempotent)", async () => {
    // NOTE: true idempotency is server-side (api/app/routers/artifacts.py:410-411
    // returns the existing record when content_hash is already set). At unit
    // level we only verify the tool surfaces whatever the API returns; the real
    // idempotent return is exercised by the integration suite (staging).
    mockRequest
      .mockResolvedValueOnce({ ok: true, status: 200, data: ACTIVE_RECORD } satisfies HttpResult)
      .mockResolvedValueOnce({ ok: true, status: 200, data: ACTIVE_RECORD } satisfies HttpResult);

    const first = await completeUploadHandler({ artifact_id: VALID_ID });
    const second = await completeUploadHandler({ artifact_id: VALID_ID });
    expect(first.isError).toBeUndefined();
    expect(second.isError).toBeUndefined();
    expect((first.content[0] as { text: string }).text).toBe(
      (second.content[0] as { text: string }).text
    );
  });
});

// ─── Handler — error translation ─────────────────────────────────────────────

describe("AF_MCP-3.3 — error translation", () => {
  it("AF_MCP-3.3.04: upload_not_found translated with §6 'not arrived at R2' guidance + filled id", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: false,
      status: 400,
      error: {
        code: "upload_not_found",
        message: "No uploaded file found for artifact.",
        status: 400,
      },
      attempts: 1,
    } satisfies HttpResult);

    const result = await completeUploadHandler({ artifact_id: VALID_ID });
    expect(result.isError).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.code).toBe("upload_not_found");
    expect(meta?.retry_hint).toBe("do_not_retry");

    const text = (result.content[0] as { text: string }).text;
    // §6 verbatim summary, with {{id}} filled by the handler's extraVars.
    expect(text).toBe(
      `Bytes for artifact ${VALID_ID} have not arrived at R2 yet. PUT to the presigned URL and retry.`
    );
  });

  it("AF_MCP-3.3.05: artifact_not_found translated (stale pending), id filled", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: {
        code: "artifact_not_found",
        message: "Artifact not found.",
        status: 404,
      },
      attempts: 1,
    } satisfies HttpResult);

    const result = await completeUploadHandler({ artifact_id: VALID_ID });
    expect(result.isError).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.code).toBe("artifact_not_found");
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain(VALID_ID);
    expect(text).toContain("does not exist or is not visible");
  });

  it("artifact_already_deleted translated (410), id filled", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: false,
      status: 410,
      error: {
        code: "artifact_already_deleted",
        message: "Artifact already deleted.",
        status: 410,
      },
      attempts: 1,
    } satisfies HttpResult);

    const result = await completeUploadHandler({ artifact_id: VALID_ID });
    expect(result.isError).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.code).toBe("artifact_already_deleted");
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain(VALID_ID);
  });
});

// ─── Auto-retry on 5xx (AF_MCP-3.3.06 / 3.3.07) ──────────────────────────────

describe("AF_MCP-3.3 — 5xx auto-retry policy", () => {
  it("AF_MCP-3.3.06/07: uses idempotentWrite policy (5xx retried up to 3× at the wire)", async () => {
    // The fake client returns the failure directly (it does not run the retry
    // loop). We assert the tool wires retryPolicy "idempotentWrite", which is
    // what enables 429-once + 5xx-up-to-3× behavior. The wire-level multi-call
    // retry is proven in http-client.test.ts ("idempotentWrite: retries 5xx up
    // to 3 times", ~line 260). Real replay-returns-same-record is exercised by
    // the integration suite (staging).
    mockRequest.mockResolvedValueOnce({
      ok: false,
      status: 502,
      error: { code: "server_error", message: "bad gateway", status: 502 },
      attempts: 4,
    } satisfies HttpResult);

    const result = await completeUploadHandler({ artifact_id: VALID_ID });
    expect(result.isError).toBe(true);
    const opts = mockRequest.mock.calls[0][0] as { retryPolicy: string };
    expect(opts.retryPolicy).toBe("idempotentWrite");
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.retry_hint).toBe("retry_with_backoff");
  });
});

// ─── Defensive runtime validation (SDK does not pre-validate inputSchema) ─────

describe("AF_MCP-3.3 — defensive runtime validation", () => {
  it("missing artifact_id → local invalid_request, API not called", async () => {
    const result = await completeUploadHandler({});
    expect(result.isError).toBe(true);
    expect(mockRequest).not.toHaveBeenCalled();
    expect((result._meta as Record<string, unknown>).code).toBe("invalid_request");
  });

  it("malformed artifact_id → local invalid_request, API not called", async () => {
    const result = await completeUploadHandler({ artifact_id: "nope" });
    expect(result.isError).toBe(true);
    expect(mockRequest).not.toHaveBeenCalled();
    expect((result._meta as Record<string, unknown>).code).toBe("invalid_request");
  });

  it("non-string artifact_id → local invalid_request, API not called", async () => {
    const result = await completeUploadHandler({
      artifact_id: 123 as unknown as string,
    });
    expect(result.isError).toBe(true);
    expect(mockRequest).not.toHaveBeenCalled();
    expect((result._meta as Record<string, unknown>).code).toBe("invalid_request");
  });
});
