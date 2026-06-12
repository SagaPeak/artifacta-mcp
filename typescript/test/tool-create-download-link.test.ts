// AF_MCP-3.4 — create_download_link tool (warn-and-cache consent, P0).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  CREATE_DOWNLOAD_LINK_DESCRIPTION,
  CREATE_DOWNLOAD_LINK_TOOL,
  createDownloadLinkHandler,
  registerCreateDownloadLinkTool,
} from "../src/tools/create-download-link.js";
import { resetHttpClient, setHttpClient } from "../src/http/instance.js";
import {
  clearRegistry,
  getToolRegistration,
  getFilteredTools,
  isCallPermitted,
} from "../src/safety/registry.js";
import { emitDestructiveAudit } from "../src/safety/audit.js";
import { compileToolSchema, checkToolSchemaContract } from "./_helpers/ajv.js";
import { ARTIFACT_ID_PATTERN } from "../src/ids/formats.js";
import type { ArtifactaHttpClient } from "../src/http/client.js";
import type { HttpResult } from "../src/http/types.js";

const VALID_ID = "art_AAAAAAAAAAAAAAAA";
const DEFAULT_EXPIRES_IN = 604800;
const MAX_EXPIRES_IN = 7776000;

const SUCCESS_BODY = {
  link_id: "lnk_BBBBBBBBBBBBBBBBBBBB",
  url: "https://dl.artifacta.io/lnk_BBBBBBBBBBBBBBBBBBBB",
  artifact_id: VALID_ID,
  expires_at: "2026-06-01T00:00:00+00:00",
  created_at: "2026-05-25T00:00:00+00:00",
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

/** Capture process.stderr.write without vi.spyOn (it isn't a prototype method). */
function captureStderr(fn: () => void): string {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join("");
}

beforeEach(() => {
  clearRegistry();
  resetHttpClient();
  installFakeClient();
  registerCreateDownloadLinkTool();
});

afterEach(() => {
  clearRegistry();
  resetHttpClient();
  vi.restoreAllMocks();
});

// ─── Registration + schema ───────────────────────────────────────────────────

describe("AF_MCP-3.4 — create_download_link registration", () => {
  it("AF_MCP-3.4 safety-class: registered with safety 'destructive' (gating)", () => {
    const reg = getToolRegistration("create_download_link");
    expect(reg).toBeDefined();
    expect(reg!.tool.name).toBe("create_download_link");
    expect(reg!.safety).toBe("destructive");
  });

  it("tool.description === CREATE_DOWNLOAD_LINK_DESCRIPTION constant", () => {
    expect(CREATE_DOWNLOAD_LINK_TOOL.description).toBe(CREATE_DOWNLOAD_LINK_DESCRIPTION);
  });

  it("description is plan §2.8 verbatim", () => {
    expect(CREATE_DOWNLOAD_LINK_DESCRIPTION).toBe(
      "Produce a stable, human-shareable URL (`https://dl.artifacta.io/lnk_<id>`) that resolves to the artifact bytes for a chosen duration. Use this when an agent needs to hand off output to a human reviewer or downstream tool that cannot inject bearer headers. Default expiry is 7 days; max is plan-dependent (30d Free, 90d Pro). Active links are quota-limited (50 Free, 500 Pro)."
    );
  });

  it("input schema satisfies the structural MCP contract", () => {
    expect(checkToolSchemaContract(CREATE_DOWNLOAD_LINK_TOOL)).toEqual([]);
  });

  it("AF_MCP-3.4 input-schema: artifact_id required (pinned to ARTIFACT_ID_PATTERN); expires_in bounded with default (§2.8)", () => {
    const s = CREATE_DOWNLOAD_LINK_TOOL.inputSchema as Record<string, unknown>;
    expect(s.required).toEqual(["artifact_id"]);
    expect(s.additionalProperties).toBe(false);
    const props = s.properties as Record<string, Record<string, unknown>>;
    expect(props.artifact_id.pattern).toBe(ARTIFACT_ID_PATTERN);
    expect(props.expires_in.type).toBe("integer");
    expect(props.expires_in.minimum).toBe(1);
    expect(props.expires_in.maximum).toBe(MAX_EXPIRES_IN);
    expect(props.expires_in.default).toBe(DEFAULT_EXPIRES_IN);
  });
});

// ─── Schema validation gate ──────────────────────────────────────────────────

describe("AF_MCP-3.4 — schema validation gate", () => {
  it("accepts a minimal valid payload (artifact_id only)", () => {
    const validate = compileToolSchema(CREATE_DOWNLOAD_LINK_TOOL);
    expect(validate({ artifact_id: VALID_ID })).toBe(true);
  });

  it("AF_MCP-3.4.08: expires_in = 1 accepted", () => {
    const validate = compileToolSchema(CREATE_DOWNLOAD_LINK_TOOL);
    expect(validate({ artifact_id: VALID_ID, expires_in: 1 })).toBe(true);
  });

  it("AF_MCP-3.4.09: expires_in = 7776000 (90 days) accepted at schema", () => {
    const validate = compileToolSchema(CREATE_DOWNLOAD_LINK_TOOL);
    expect(validate({ artifact_id: VALID_ID, expires_in: MAX_EXPIRES_IN })).toBe(true);
  });

  it("AF_MCP-3.4.10: expires_in = 0 rejected at schema", () => {
    const validate = compileToolSchema(CREATE_DOWNLOAD_LINK_TOOL);
    expect(validate({ artifact_id: VALID_ID, expires_in: 0 })).toBe(false);
  });

  it("expires_in over 90 days rejected at schema", () => {
    const validate = compileToolSchema(CREATE_DOWNLOAD_LINK_TOOL);
    expect(validate({ artifact_id: VALID_ID, expires_in: MAX_EXPIRES_IN + 1 })).toBe(false);
  });

  it("rejects invalid artifact_id", () => {
    const validate = compileToolSchema(CREATE_DOWNLOAD_LINK_TOOL);
    expect(validate({ artifact_id: "invalid" })).toBe(false);
  });

  it("rejects additionalProperties", () => {
    const validate = compileToolSchema(CREATE_DOWNLOAD_LINK_TOOL);
    expect(validate({ artifact_id: VALID_ID, extra: 1 })).toBe(false);
  });
});

// ─── Autonomy gating (AF_MCP-3.4.01–3.4.03) ──────────────────────────────────

describe("AF_MCP-3.4 — autonomy gating (destructive)", () => {
  it("AF_MCP-3.4.01: compliant client → tool present with meta.requiresConfirmation: true", () => {
    const tools = getFilteredTools({
      hasConfirmations: true,
      allowDestructive: false,
      writeConfirmRequired: false,
    });
    const tool = tools.find((t) => t.name === "create_download_link");
    expect(tool).toBeDefined();
    expect((tool!._meta as Record<string, unknown>).requiresConfirmation).toBe(true);
  });

  it("AF_MCP-3.4.02: non-compliant client without --allow-destructive → tool absent", () => {
    const tools = getFilteredTools({
      hasConfirmations: false,
      allowDestructive: false,
      writeConfirmRequired: false,
    });
    expect(tools.find((t) => t.name === "create_download_link")).toBeUndefined();
  });

  it("AF_MCP-3.4.03: non-compliant client + --allow-destructive → tool present (no confirmation flag)", () => {
    const tools = getFilteredTools({
      hasConfirmations: false,
      allowDestructive: true,
      writeConfirmRequired: false,
    });
    const tool = tools.find((t) => t.name === "create_download_link");
    expect(tool).toBeDefined();
    // No confirmation surface on a non-compliant client → no requiresConfirmation.
    expect((tool!._meta as Record<string, unknown> | undefined)?.requiresConfirmation).toBeUndefined();
  });

  it("isCallPermitted: blocked for non-compliant + !allow-destructive; permitted otherwise", () => {
    const reg = getToolRegistration("create_download_link")!;
    expect(isCallPermitted(reg, false, false)).toBe(false);
    expect(isCallPermitted(reg, true, false)).toBe(true); // compliant
    expect(isCallPermitted(reg, false, true)).toBe(true); // --allow-destructive
  });
});

// ─── Destructive audit line (AF_MCP-3.4.04) ──────────────────────────────────

describe("AF_MCP-3.4 — destructive audit (§5)", () => {
  it("AF_MCP-3.4.04: emitDestructiveAudit writes the §5 stderr warning for this tool", () => {
    const out = captureStderr(() =>
      emitDestructiveAudit("create_download_link", { artifact_id: VALID_ID, expires_in: 3600 })
    );
    expect(out).toContain("[artifacta-mcp] destructive call: create_download_link(");
    expect(out).toContain("— no confirmation surface");
  });

  it("audit redacts secret-looking args (redaction not bypassed for this tool)", () => {
    const out = captureStderr(() =>
      emitDestructiveAudit("create_download_link", { token: "ak_live_supersecretvalue" })
    );
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("ak_live_supersecretvalue");
  });
});

// ─── Handler — happy path ────────────────────────────────────────────────────

describe("AF_MCP-3.4 — create_download_link handler (success)", () => {
  it("AF_MCP-3.4.05/06: success → POST /v1/artifacts/{id}/links; returns dl.artifacta.io link", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 201,
      data: SUCCESS_BODY,
    } satisfies HttpResult);

    const result = await createDownloadLinkHandler({ artifact_id: VALID_ID });
    expect(result.isError).toBeUndefined();
    expect(mockRequest).toHaveBeenCalledOnce();
    const opts = mockRequest.mock.calls[0][0] as {
      method: string;
      path: string;
      retryPolicy: string;
    };
    expect(opts.method).toBe("POST");
    expect(opts.path).toBe(`/v1/artifacts/${VALID_ID}/links`);

    const parsed = JSON.parse(
      (result.content[0] as { text: string }).text
    ) as Record<string, unknown>;
    expect(parsed).toEqual(SUCCESS_BODY);
    expect(parsed.link_id).toBe(SUCCESS_BODY.link_id);
    expect(parsed.url).toMatch(/^https:\/\/dl\.artifacta\.io\/lnk_[A-Za-z0-9]{20}$/);
    expect(parsed.expires_at).toBe(SUCCESS_BODY.expires_at);
    expect(parsed.created_at).toBe(SUCCESS_BODY.created_at);
  });

  it("AF_MCP-3.4.07: default expires_in (604800) injected when caller omits it", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 201,
      data: SUCCESS_BODY,
    } satisfies HttpResult);
    await createDownloadLinkHandler({ artifact_id: VALID_ID });
    const opts = mockRequest.mock.calls[0][0] as { body: { expires_in: number } };
    expect(opts.body.expires_in).toBe(DEFAULT_EXPIRES_IN);
  });

  it("forwards a caller-supplied expires_in verbatim", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 201,
      data: SUCCESS_BODY,
    } satisfies HttpResult);
    await createDownloadLinkHandler({ artifact_id: VALID_ID, expires_in: 3600 });
    const opts = mockRequest.mock.calls[0][0] as { body: { expires_in: number } };
    expect(opts.body.expires_in).toBe(3600);
  });
});

// ─── Handler — tier gates + error translation ────────────────────────────────

describe("AF_MCP-3.4 — tier gates + error translation", () => {
  it("AF_MCP-3.4.11: Free-tier expiry over limit → invalid_request with upgrade message", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: false,
      status: 400,
      error: {
        code: "invalid_request",
        message:
          "Link expiry exceeds your plan's 30-day limit. Upgrade to Pro for up to 90-day links at https://app.artifacta.io/dashboard/billing",
        status: 400,
        upgrade_url: "https://app.artifacta.io/dashboard/billing",
      },
      attempts: 1,
    } satisfies HttpResult);

    const result = await createDownloadLinkHandler({ artifact_id: VALID_ID, expires_in: 2592001 });
    expect(result.isError).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.code).toBe("invalid_request");
    expect(meta?.retry_hint).toBe("do_not_retry");
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Upgrade to Pro");
  });

  it("AF_MCP-3.4.12: active-link quota exceeded → quota_exceeded with upgrade message", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: false,
      status: 403,
      error: {
        code: "quota_exceeded",
        message:
          "Active download link limit reached (50). Upgrade to Pro for up to 500 active links at https://app.artifacta.io/dashboard/billing",
        status: 403,
        upgrade_url: "https://app.artifacta.io/dashboard/billing",
      },
      attempts: 1,
    } satisfies HttpResult);

    const result = await createDownloadLinkHandler({ artifact_id: VALID_ID });
    expect(result.isError).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.code).toBe("quota_exceeded");
    expect(meta?.upgrade_url).toBe("https://app.artifacta.io/dashboard/billing");
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Active download link limit reached");
  });

  it("AF_MCP-3.4.16: artifact_not_found translated with filled id", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: { code: "artifact_not_found", message: "Artifact not found.", status: 404 },
      attempts: 1,
    } satisfies HttpResult);

    const result = await createDownloadLinkHandler({ artifact_id: VALID_ID });
    expect(result.isError).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.code).toBe("artifact_not_found");
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain(VALID_ID);
    expect(text).toContain("does not exist or is not visible");
  });
});

// ─── No Idempotency-Key + 5xx no-retry + ambiguous completion ────────────────

describe("AF_MCP-3.4 — non-idempotent semantics", () => {
  it("AF_MCP-3.4.13: tool never sets callerIdempotencyKey (no key on the wire)", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 201,
      data: SUCCESS_BODY,
    } satisfies HttpResult);
    await createDownloadLinkHandler({ artifact_id: VALID_ID });
    const opts = mockRequest.mock.calls[0][0] as { callerIdempotencyKey?: string };
    expect(opts.callerIdempotencyKey).toBeUndefined();
  });

  it("AF_MCP-3.4.14: 5xx → no auto-retry; exactly 1 HTTP call with nonIdempotentWrite policy", async () => {
    // Fake client returns the failure directly (no retry loop). Exactly-one-call
    // proves the tool never loops; the policy assertion proves no-5xx-retry is
    // wired. Wire-level single-call-on-502 is proven in http-client.test.ts
    // ("create_download_link 502 does NOT trigger retry", ~line 241).
    mockRequest.mockResolvedValueOnce({
      ok: false,
      status: 502,
      error: { code: "server_error", message: "bad gateway", status: 502 },
      attempts: 1,
      ambiguousCompletion: true,
    } satisfies HttpResult);

    const result = await createDownloadLinkHandler({ artifact_id: VALID_ID });
    expect(result.isError).toBe(true);
    expect(mockRequest).toHaveBeenCalledOnce();
    const opts = mockRequest.mock.calls[0][0] as { retryPolicy: string };
    expect(opts.retryPolicy).toBe("nonIdempotentWrite");
  });

  it("AF_MCP-3.4.15: 5xx error text contains §6.1 guidance incl. the 'no list-links API' note", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: false,
      status: 502,
      error: { code: "server_error", message: "bad gateway", status: 502 },
      attempts: 1,
      ambiguousCompletion: true,
    } satisfies HttpResult);

    const result = await createDownloadLinkHandler({ artifact_id: VALID_ID });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Artifacta API failed mid-write on create_download_link");
    expect(text).toContain("there is no list-links API in v1");
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.retry_hint).toBe("do_not_retry");
  });
});

// ─── Defensive runtime validation ────────────────────────────────────────────

describe("AF_MCP-3.4 — defensive runtime validation", () => {
  it("missing artifact_id → local invalid_request, API not called", async () => {
    const result = await createDownloadLinkHandler({});
    expect(result.isError).toBe(true);
    expect(mockRequest).not.toHaveBeenCalled();
    expect((result._meta as Record<string, unknown>).code).toBe("invalid_request");
  });

  it("malformed artifact_id → local invalid_request, API not called", async () => {
    const result = await createDownloadLinkHandler({ artifact_id: "nope" });
    expect(result.isError).toBe(true);
    expect(mockRequest).not.toHaveBeenCalled();
    expect((result._meta as Record<string, unknown>).code).toBe("invalid_request");
  });

  it("non-integer expires_in → local invalid_request, API not called", async () => {
    const result = await createDownloadLinkHandler({ artifact_id: VALID_ID, expires_in: 1.5 });
    expect(result.isError).toBe(true);
    expect(mockRequest).not.toHaveBeenCalled();
    expect((result._meta as Record<string, unknown>).code).toBe("invalid_request");
  });

  it("expires_in out of range → local invalid_request, API not called", async () => {
    const result = await createDownloadLinkHandler({
      artifact_id: VALID_ID,
      expires_in: MAX_EXPIRES_IN + 1,
    });
    expect(result.isError).toBe(true);
    expect(mockRequest).not.toHaveBeenCalled();
    expect((result._meta as Record<string, unknown>).code).toBe("invalid_request");
  });
});
