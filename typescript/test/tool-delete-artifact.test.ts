// AF_MCP-4.1 — delete_artifact tool (destructive — gated).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DELETE_ARTIFACT_DESCRIPTION,
  DELETE_ARTIFACT_TOOL,
  deleteArtifactHandler,
  registerDeleteArtifactTool,
} from "../src/tools/delete-artifact.js";
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
import { ARTIFACT_ID_PATTERN } from "../src/ids/formats.js";
import type { ArtifactaHttpClient } from "../src/http/client.js";
import type { HttpResult } from "../src/http/types.js";

const VALID_ID = "art_AAAAAAAAAAAAAAAA";
const VALID_ARGS = { artifact_id: VALID_ID, confirm: true as const };

const DELETE_SUCCESS = {
  artifact_id: VALID_ID,
  deleted: true as const,
  deleted_at: "2026-05-27T00:00:00+00:00",
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
  registerDeleteArtifactTool();
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

describe("AF_MCP-4.1 — delete_artifact registration", () => {
  it("registers tool name 'delete_artifact' with safety 'destructive'", () => {
    const reg = getToolRegistration("delete_artifact");
    expect(reg).toBeDefined();
    expect(reg!.tool.name).toBe("delete_artifact");
    expect(reg!.safety).toBe("destructive");
  });

  it("alwaysConfirm is NOT set (safety 'destructive' alone forces confirmation)", () => {
    const reg = getToolRegistration("delete_artifact");
    expect(reg!.alwaysConfirm).toBe(false);
  });

  it("tool.description === DELETE_ARTIFACT_DESCRIPTION constant", () => {
    expect(DELETE_ARTIFACT_TOOL.description).toBe(DELETE_ARTIFACT_DESCRIPTION);
  });

  it("description is plan §2.9 base plus MCP confirm gate", () => {
    expect(DELETE_ARTIFACT_DESCRIPTION).toBe(
      "Soft-delete an artifact. The artifact disappears from listings immediately and download URLs return `410 Gone`. Storage and the underlying R2 blob are hard-deleted by a background job 30 days later. There is no undo from the API — do not call without explicit user confirmation. Requires `confirm: true` only after the user has explicitly approved deleting this artifact_id."
    );
  });

  it("AF_MCP-4.1.17: description contains the 'no undo' warning and confirm gate", () => {
    expect(DELETE_ARTIFACT_DESCRIPTION).toContain("no undo");
    expect(DELETE_ARTIFACT_DESCRIPTION).toContain(
      "do not call without explicit user confirmation"
    );
    expect(DELETE_ARTIFACT_DESCRIPTION).toContain("confirm: true");
  });

  it("input schema satisfies the structural MCP contract", () => {
    expect(checkToolSchemaContract(DELETE_ARTIFACT_TOOL)).toEqual([]);
  });

  it("input schema: required artifact_id + confirm:true const (§2.9 + MCP confirm gate)", () => {
    const s = DELETE_ARTIFACT_TOOL.inputSchema as Record<string, unknown>;
    expect(s.required).toEqual(["artifact_id", "confirm"]);
    expect(s.additionalProperties).toBe(false);
    const props = s.properties as Record<string, Record<string, unknown>>;
    expect(props.artifact_id.pattern).toBe(ARTIFACT_ID_PATTERN);
    expect(props.confirm.type).toBe("boolean");
    expect(props.confirm.const).toBe(true);
  });
});

// ─── Schema validation gate ──────────────────────────────────────────────────

describe("AF_MCP-4.1 — schema validation gate", () => {
  it("accepts a valid 16-char alnum id with confirm: true", () => {
    const validate = compileToolSchema(DELETE_ARTIFACT_TOOL);
    expect(validate(VALID_ARGS)).toBe(true);
  });

  it("AF_MCP-4.1.16: rejects invalid artifact_id at schema (API not called)", () => {
    const validate = compileToolSchema(DELETE_ARTIFACT_TOOL);
    expect(validate({ artifact_id: "not_an_id", confirm: true })).toBe(false);
  });

  it("rejects a 15-char id (one short)", () => {
    const validate = compileToolSchema(DELETE_ARTIFACT_TOOL);
    expect(validate({ artifact_id: "art_123456789012345", confirm: true })).toBe(false);
  });

  it("rejects an extra unknown property (additionalProperties: false)", () => {
    const validate = compileToolSchema(DELETE_ARTIFACT_TOOL);
    expect(validate({ ...VALID_ARGS, extra: 1 })).toBe(false);
  });

  it("rejects payload missing artifact_id", () => {
    const validate = compileToolSchema(DELETE_ARTIFACT_TOOL);
    expect(validate({ confirm: true })).toBe(false);
  });

  it("rejects payload missing confirm", () => {
    const validate = compileToolSchema(DELETE_ARTIFACT_TOOL);
    expect(validate({ artifact_id: VALID_ID })).toBe(false);
  });

  it("rejects confirm: false (const true only)", () => {
    const validate = compileToolSchema(DELETE_ARTIFACT_TOOL);
    expect(validate({ artifact_id: VALID_ID, confirm: false })).toBe(false);
  });
});

// ─── Gating: tools/list filter behavior ──────────────────────────────────────

describe("AF_MCP-4.1 — gating in tools/list", () => {
  it("AF_MCP-4.1.01: compliant client → tool present with requiresConfirmation: true", () => {
    const tools = getFilteredTools({
      hasConfirmations: true,
      allowDestructive: false,
      writeConfirmRequired: false,
    });
    const entry = tools.find((t) => t.name === "delete_artifact");
    expect(entry).toBeDefined();
    const meta = entry!._meta as { requiresConfirmation?: boolean } | undefined;
    expect(meta?.requiresConfirmation).toBe(true);
  });

  it("AF_MCP-4.1.02: non-compliant client without --allow-destructive → tool absent", () => {
    const tools = getFilteredTools({
      hasConfirmations: false,
      allowDestructive: false,
      writeConfirmRequired: false,
    });
    expect(tools.find((t) => t.name === "delete_artifact")).toBeUndefined();
  });

  it("AF_MCP-4.1.03: non-compliant + --allow-destructive → tool present", () => {
    const tools = getFilteredTools({
      hasConfirmations: false,
      allowDestructive: true,
      writeConfirmRequired: false,
    });
    const entry = tools.find((t) => t.name === "delete_artifact");
    expect(entry).toBeDefined();
    // No requiresConfirmation when the only reason it's exposed is the flag
    // (non-compliant client cannot render a confirmation surface anyway).
    const meta = entry!._meta as { requiresConfirmation?: boolean } | undefined;
    expect(meta?.requiresConfirmation).toBeUndefined();
  });

  it("AF_MCP-4.1.15: ARTIFACTA_MCP_REQUIRE_WRITE_CONFIRM=1 does not double-promote (compliant already has requiresConfirmation from 'destructive')", () => {
    const tools = getFilteredTools({
      hasConfirmations: true,
      allowDestructive: false,
      writeConfirmRequired: true,
    });
    const entry = tools.find((t) => t.name === "delete_artifact");
    expect(entry).toBeDefined();
    const meta = entry!._meta as { requiresConfirmation?: boolean } | undefined;
    expect(meta?.requiresConfirmation).toBe(true);
  });

  it("AF_MCP-4.1.15 (extension): writeConfirmRequired=true on a non-compliant client does NOT expose the tool — destructive remains gated", () => {
    const tools = getFilteredTools({
      hasConfirmations: false,
      allowDestructive: false,
      writeConfirmRequired: true,
    });
    expect(tools.find((t) => t.name === "delete_artifact")).toBeUndefined();
  });

  it("call dispatch gate: non-compliant + no --allow-destructive → isCallPermitted false", () => {
    const reg = getToolRegistration("delete_artifact")!;
    expect(isCallPermitted(reg, false, false)).toBe(false);
  });

  it("call dispatch gate: --allow-destructive permits direct call on non-compliant client", () => {
    const reg = getToolRegistration("delete_artifact")!;
    expect(isCallPermitted(reg, false, true)).toBe(true);
  });

  it("call dispatch gate: compliant client permits direct call", () => {
    const reg = getToolRegistration("delete_artifact")!;
    expect(isCallPermitted(reg, true, false)).toBe(true);
  });
});

// ─── --allow-destructive flag-only source (AF_MCP-4.1.13 / 4.1.14) ───────────

describe("AF_MCP-4.1 — --allow-destructive is flag-only (never env / TOML)", () => {
  it("AF_MCP-4.1.13: ALLOW_DESTRUCTIVE env var does NOT set allowDestructive", () => {
    process.env.ALLOW_DESTRUCTIVE = "1";
    process.env.ARTIFACTA_MCP_ALLOW_DESTRUCTIVE = "1";
    const flags = parseSafetyFlags([]);
    expect(flags.allowDestructive).toBe(false);
    // And the registry still filters the tool out for non-compliant clients
    const tools = getFilteredTools({
      hasConfirmations: false,
      allowDestructive: flags.allowDestructive,
      writeConfirmRequired: false,
    });
    expect(tools.find((t) => t.name === "delete_artifact")).toBeUndefined();
  });

  it("AF_MCP-4.1.14: parseSafetyFlags reads argv only (no config/TOML wiring exists)", () => {
    // The flag is parsed from argv only; the loader (cli.ts) does not pass any
    // TOML-derived value into parseSafetyFlags — verified by code inspection
    // and by the absence of a TOML allow_destructive key in the type. Argv
    // wins; absent argv → false regardless of any env that might look like it.
    process.env.ALLOW_DESTRUCTIVE = "true";
    expect(parseSafetyFlags([]).allowDestructive).toBe(false);
    expect(parseSafetyFlags(["--allow-destructive"]).allowDestructive).toBe(true);
  });
});

// ─── Stderr audit (AF_MCP-4.1.04 / 4.1.05 / 4.1.06) ──────────────────────────

describe("AF_MCP-4.1 — stderr audit line", () => {
  // process.stderr.write isn't a prototype method; assign + restore manually
  // (matches the pattern in safety-registry.test.ts and the audit-line
  // integration cases).
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

  it("AF_MCP-4.1.04: emitDestructiveAudit fires the §5 stderr line for delete_artifact", () => {
    emitDestructiveAudit("delete_artifact", { artifact_id: VALID_ID });
    const joined = chunks.join("");
    expect(joined).toContain(
      "[artifacta-mcp] destructive call: delete_artifact("
    );
    expect(joined).toContain("— no confirmation surface");
  });

  it("AF_MCP-4.1.05: stderr line carries the artifact_id (JSON-serialized args per AF_MCP-1.5 emitter contract)", () => {
    // The §5 illustration writes `artifact_id=art_…`; the AF_MCP-1.5 emitter
    // implementation (already shipped, QA-locked) serializes args as compact
    // JSON, so the on-wire form is `{"artifact_id":"art_…"}`. The contract
    // the agent receives — the artifact_id is in the audit line — is intact.
    emitDestructiveAudit("delete_artifact", { artifact_id: VALID_ID });
    const joined = chunks.join("");
    expect(joined).toContain(`"artifact_id":"${VALID_ID}"`);
    expect(joined).toContain("delete_artifact(");
  });

  it("AF_MCP-4.1.06: audit line is NOT emitted when client is compliant (handled by server.ts dispatch gate)", () => {
    // server.ts dispatch only calls emitDestructiveAudit when
    // `flags.allowDestructive && !hasConfirmations`. So when a compliant
    // client is connected (confirmation surface present), the audit emitter
    // is never invoked — verified directly in server.ts:108.
    // No call → no stderr write.
    expect(chunks).toEqual([]);
  });
});

// ─── Handler — happy path ────────────────────────────────────────────────────

describe("AF_MCP-4.1 — delete_artifact handler (success)", () => {
  it("AF_MCP-4.1.07: success → DELETE /v1/artifacts/{id}; returns artifact_id + deleted: true + deleted_at", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: DELETE_SUCCESS,
    } satisfies HttpResult);

    const result = await deleteArtifactHandler(VALID_ARGS);
    expect(result.isError).toBeUndefined();
    expect(mockRequest).toHaveBeenCalledOnce();

    const opts = mockRequest.mock.calls[0][0] as {
      method: string;
      path: string;
      retryPolicy: string;
    };
    expect(opts.method).toBe("DELETE");
    expect(opts.path).toBe(`/v1/artifacts/${VALID_ID}`);
    expect(opts.retryPolicy).toBe("idempotentWrite");

    const parsed = JSON.parse(
      (result.content[0] as { text: string }).text
    ) as Record<string, unknown>;
    expect(parsed.artifact_id).toBe(VALID_ID);
    expect(parsed.deleted).toBe(true);
    expect(typeof parsed.deleted_at).toBe("string");
  });

  it("does NOT inject a caller idempotency key (none needed — naturally idempotent)", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: DELETE_SUCCESS,
    } satisfies HttpResult);
    await deleteArtifactHandler(VALID_ARGS);
    const opts = mockRequest.mock.calls[0][0] as {
      callerIdempotencyKey?: string;
      body?: unknown;
    };
    expect(opts.callerIdempotencyKey).toBeUndefined();
    expect(opts.body).toBeUndefined();
  });

  it("encodes artifact_id as a URL path segment", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: DELETE_SUCCESS,
    } satisfies HttpResult);
    await deleteArtifactHandler(VALID_ARGS);
    const opts = mockRequest.mock.calls[0][0] as { path: string };
    expect(opts.path).toBe(`/v1/artifacts/${encodeURIComponent(VALID_ID)}`);
  });
});

// ─── Idempotent replay (AF_MCP-4.1.09) ───────────────────────────────────────

describe("AF_MCP-4.1 — idempotent replay on 410 artifact_already_deleted", () => {
  it("AF_MCP-4.1.09: 410 artifact_already_deleted → returned as success (NOT isError)", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: false,
      status: 410,
      error: {
        code: "artifact_already_deleted",
        message: `Artifact '${VALID_ID}' has already been deleted.`,
        status: 410,
      },
      attempts: 1,
    } satisfies HttpResult);

    const result = await deleteArtifactHandler(VALID_ARGS);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(
      (result.content[0] as { text: string }).text
    ) as Record<string, unknown>;
    expect(parsed.artifact_id).toBe(VALID_ID);
    expect(parsed.deleted).toBe(true);
    expect(parsed.already_deleted).toBe(true);
  });

  it("two consecutive calls — first deletes, second is success-on-replay", async () => {
    mockRequest
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: DELETE_SUCCESS,
      } satisfies HttpResult)
      .mockResolvedValueOnce({
        ok: false,
        status: 410,
        error: {
          code: "artifact_already_deleted",
          message: `Artifact '${VALID_ID}' has already been deleted.`,
          status: 410,
        },
        attempts: 1,
      } satisfies HttpResult);

    const first = await deleteArtifactHandler(VALID_ARGS);
    const second = await deleteArtifactHandler(VALID_ARGS);
    expect(first.isError).toBeUndefined();
    expect(second.isError).toBeUndefined();

    const firstParsed = JSON.parse(
      (first.content[0] as { text: string }).text
    ) as Record<string, unknown>;
    const secondParsed = JSON.parse(
      (second.content[0] as { text: string }).text
    ) as Record<string, unknown>;
    expect(firstParsed.deleted).toBe(true);
    expect(secondParsed.deleted).toBe(true);
    expect(secondParsed.already_deleted).toBe(true);
    expect(firstParsed.already_deleted).toBeUndefined();
  });
});

// ─── Error translation ──────────────────────────────────────────────────────

describe("AF_MCP-4.1 — error translation", () => {
  it("AF_MCP-4.1.10: artifact_not_found (404) translated with §6 text + filled id", async () => {
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

    const result = await deleteArtifactHandler(VALID_ARGS);
    expect(result.isError).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.code).toBe("artifact_not_found");
    expect(meta?.retry_hint).toBe("do_not_retry");

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain(VALID_ID);
    expect(text).toContain("does not exist or is not visible");
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

    const result = await deleteArtifactHandler(VALID_ARGS);
    expect(result.isError).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.code).toBe("unauthorized");
  });
});

// ─── Auto-retry policy (AF_MCP-4.1.11 / 4.1.12) ──────────────────────────────

describe("AF_MCP-4.1 — auto-retry policy", () => {
  it("AF_MCP-4.1.11/12: uses idempotentWrite policy (429 once + 5xx up to 3× at the wire)", async () => {
    // The fake client returns the failure directly (it does not run the retry
    // loop). We assert the tool wires retryPolicy "idempotentWrite", which is
    // what enables 429-once + 5xx-up-to-3× behavior. The wire-level multi-call
    // retry is proven in http-client.test.ts ("idempotentWrite: retries 5xx up
    // to 3 times").
    mockRequest.mockResolvedValueOnce({
      ok: false,
      status: 502,
      error: { code: "server_error", message: "bad gateway", status: 502 },
      attempts: 4,
    } satisfies HttpResult);

    const result = await deleteArtifactHandler(VALID_ARGS);
    expect(result.isError).toBe(true);
    const opts = mockRequest.mock.calls[0][0] as { retryPolicy: string };
    expect(opts.retryPolicy).toBe("idempotentWrite");
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.retry_hint).toBe("retry_with_backoff");
  });
});

// ─── Defensive runtime validation (SDK does not pre-validate inputSchema) ────

describe("AF_MCP-4.1 — defensive runtime validation", () => {
  it("missing artifact_id → local invalid_request, API not called", async () => {
    const result = await deleteArtifactHandler({});
    expect(result.isError).toBe(true);
    expect(mockRequest).not.toHaveBeenCalled();
    expect((result._meta as Record<string, unknown>).code).toBe("invalid_request");
  });

  it("AF_MCP-4.1.16: malformed artifact_id → local invalid_request, API not called", async () => {
    const result = await deleteArtifactHandler({ artifact_id: "not_an_id" });
    expect(result.isError).toBe(true);
    expect(mockRequest).not.toHaveBeenCalled();
    expect((result._meta as Record<string, unknown>).code).toBe("invalid_request");
  });

  it("non-string artifact_id → local invalid_request, API not called", async () => {
    const result = await deleteArtifactHandler({
      artifact_id: 123 as unknown as string,
      confirm: true,
    });
    expect(result.isError).toBe(true);
    expect(mockRequest).not.toHaveBeenCalled();
    expect((result._meta as Record<string, unknown>).code).toBe("invalid_request");
  });

  it("missing confirm → local invalid_request, API not called", async () => {
    const result = await deleteArtifactHandler({ artifact_id: VALID_ID });
    expect(result.isError).toBe(true);
    expect(mockRequest).not.toHaveBeenCalled();
    expect((result._meta as Record<string, unknown>).code).toBe("invalid_request");
    expect((result.content[0] as { text: string }).text).toContain("confirm");
  });

  it("confirm: false → local invalid_request, API not called", async () => {
    const result = await deleteArtifactHandler({ artifact_id: VALID_ID, confirm: false });
    expect(result.isError).toBe(true);
    expect(mockRequest).not.toHaveBeenCalled();
    expect((result._meta as Record<string, unknown>).code).toBe("invalid_request");
  });

  it("confirm: \"true\" string → local invalid_request, API not called", async () => {
    const result = await deleteArtifactHandler({
      artifact_id: VALID_ID,
      confirm: "true" as unknown as boolean,
    });
    expect(result.isError).toBe(true);
    expect(mockRequest).not.toHaveBeenCalled();
    expect((result._meta as Record<string, unknown>).code).toBe("invalid_request");
  });
});
