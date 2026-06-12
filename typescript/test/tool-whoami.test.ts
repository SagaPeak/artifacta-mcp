// AF_MCP-2.1 — whoami tool + artifacta://whoami resource.
//
// Exercises the unit-level gates from the Phase 4 QA spec (AF_MCP-2.1.01–10
// minus the ones that require the live API or the http-client retry layer,
// which have their own coverage).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  WHOAMI_DESCRIPTION,
  WHOAMI_TOOL,
  fetchWhoami,
  registerWhoamiTool,
  whoamiHandler,
} from "../src/tools/whoami.js";
import {
  WHOAMI_RESOURCE,
  WHOAMI_RESOURCE_URI,
  registerWhoamiResource,
} from "../src/resources/whoami.js";
import {
  resetHttpClient,
  setHttpClient,
} from "../src/http/instance.js";
import {
  clearResourceRegistry,
  getResourceReader,
  listResources,
} from "../src/resources/registry.js";
import {
  clearRegistry,
  getToolRegistration,
} from "../src/safety/registry.js";
import {
  cacheKeySuffix,
  clearKeySuffixCache,
} from "../src/whoami-cache.js";
import { translateHttpFailure } from "../src/errors/translate.js";
import { compileToolSchema, checkToolSchemaContract } from "./_helpers/ajv.js";
import type {
  ArtifactaHttpClient,
} from "../src/http/client.js";
import type { HttpResult } from "../src/http/types.js";

const VALID_BODY = {
  tenant_name: "acme",
  plan: "free",
  api_key_last_4: "abcd",
  usage_requests_month: 12,
  plan_requests_limit_month: 1000,
  usage_storage_bytes: 1024,
  plan_storage_limit_bytes: 1073741824,
  active_links: 1,
  max_active_links: 50,
  rate_limit_sustained: 60,
  rate_limit_burst: 120,
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
  clearResourceRegistry();
  clearKeySuffixCache();
  resetHttpClient();
  installFakeClient();
  registerWhoamiTool();
  registerWhoamiResource();
});

afterEach(() => {
  clearRegistry();
  clearResourceRegistry();
  clearKeySuffixCache();
  resetHttpClient();
  vi.restoreAllMocks();
});

// ─── Tool registration ───────────────────────────────────────────────────────

describe("AF_MCP-2.1 — whoami tool registration", () => {
  it("registers tool name 'whoami' with safety 'safe' and the §2.1 input schema", () => {
    const reg = getToolRegistration("whoami");
    expect(reg).toBeDefined();
    expect(reg!.tool.name).toBe("whoami");
    expect(reg!.safety).toBe("safe");
    expect(reg!.alwaysConfirm).toBe(false);
    expect(reg!.tool.inputSchema).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    });
  });

  it("description matches plan §2.1 verbatim", () => {
    expect(WHOAMI_TOOL.description).toBe(WHOAMI_DESCRIPTION);
    // Anchor checks against the spec text — fail loudly if anyone paraphrases.
    expect(WHOAMI_DESCRIPTION).toBe(
      "Return the calling tenant's identity, plan tier, current usage counters (storage bytes, monthly requests, active links), and rate limits. Use this once at the start of an agent run to confirm authentication and to size subsequent operations against quota. Free of side effects and quota-cheap."
    );
  });

  it("input schema satisfies the structural MCP tool contract", () => {
    const failures = checkToolSchemaContract(WHOAMI_TOOL);
    expect(failures).toEqual([]);
  });

  it("input schema accepts an empty object and rejects extra properties", () => {
    const validate = compileToolSchema(WHOAMI_TOOL);
    expect(validate({})).toBe(true);
    expect(validate({ extra_field: 1 })).toBe(false);
    expect(validate({ session_id: "anything" })).toBe(false);
  });
});

// ─── fetchWhoami — shared GET /v1/whoami implementation ──────────────────────

describe("AF_MCP-2.1 — fetchWhoami", () => {
  it("calls GET /v1/whoami with retryPolicy 'read'", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: VALID_BODY,
    } satisfies HttpResult);
    await fetchWhoami();
    expect(mockRequest).toHaveBeenCalledOnce();
    const opts = mockRequest.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.method).toBe("GET");
    expect(opts.path).toBe("/v1/whoami");
    expect(opts.retryPolicy).toBe("read");
  });

  it("populates the auth-remediation cache with api_key_last_4 on success", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: VALID_BODY,
    } satisfies HttpResult);
    const r = await fetchWhoami();
    expect(r.ok).toBe(true);
    // Indirect verification via translateHttpFailure — the cache surface
    // contractually ends up in the unauthorized remediation message.
    const t = translateHttpFailure(
      {
        ok: false,
        status: 401,
        error: { code: "unauthorized", message: "rotated", status: 401 },
        attempts: 1,
      },
      "any_tool"
    );
    const text = (t.content[0] as { text: string }).text;
    expect(text).toContain("****abcd");
  });

  it("does NOT populate the cache when the call fails", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: false,
      status: 401,
      error: { code: "unauthorized", message: "bad key", status: 401 },
      attempts: 1,
    } satisfies HttpResult);
    const r = await fetchWhoami();
    expect(r.ok).toBe(false);
    const t = translateHttpFailure(
      {
        ok: false,
        status: 401,
        error: { code: "unauthorized", message: "bad", status: 401 },
        attempts: 1,
      },
      "any_tool"
    );
    const text = (t.content[0] as { text: string }).text;
    expect(text).not.toMatch(/\*\*\*\*[A-Za-z0-9]{4}/);
  });
});

// ─── Tool handler ────────────────────────────────────────────────────────────

describe("AF_MCP-2.1 — whoami tool handler", () => {
  it("returns a single text content block with the pretty-printed JSON body", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: VALID_BODY,
    } satisfies HttpResult);
    const result: CallToolResult = await whoamiHandler();
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    const block = result.content[0];
    expect(block.type).toBe("text");
    const text = (block as { text: string }).text;
    expect(JSON.parse(text)).toEqual(VALID_BODY);
    // Pretty-printed (2-space indent → contains a newline + leading spaces).
    expect(text).toMatch(/\n {2}"tenant_name"/);
  });

  it("response JSON exposes only the fields the API returned (no synthesis)", async () => {
    // Sensitive fields the API explicitly never returns: tenant_id, key_hash,
    // deleted_at. The MCP server is a pure passthrough, so the tool must
    // neither inject these nor ever surface them.
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: VALID_BODY,
    } satisfies HttpResult);
    const result = await whoamiHandler();
    const text = (result.content[0] as { text: string }).text;
    const parsed = JSON.parse(text) as Record<string, unknown>;
    // Required fields per task notes:
    expect(parsed).toHaveProperty("tenant_name");
    expect(parsed).toHaveProperty("plan");
    expect(parsed).toHaveProperty("api_key_last_4");
    expect(parsed).toHaveProperty("usage_requests_month");
    expect(parsed).toHaveProperty("plan_requests_limit_month");
    expect(parsed).toHaveProperty("usage_storage_bytes");
    expect(parsed).toHaveProperty("plan_storage_limit_bytes");
    expect(parsed).toHaveProperty("active_links");
    expect(parsed).toHaveProperty("max_active_links");
    expect(parsed).toHaveProperty("rate_limit_sustained");
    expect(parsed).toHaveProperty("rate_limit_burst");
    // Forbidden fields:
    expect(parsed).not.toHaveProperty("tenant_id");
    expect(parsed).not.toHaveProperty("key_hash");
    expect(parsed).not.toHaveProperty("deleted_at");
  });

  it("returns translated unauthorized result with §4.3 remediation text", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: false,
      status: 401,
      error: {
        code: "unauthorized",
        message: "Invalid API key",
        status: 401,
      },
      attempts: 1,
    } satisfies HttpResult);
    const result = await whoamiHandler();
    expect(result.isError).toBe(true);
    const meta = result._meta as Record<string, unknown> | undefined;
    expect(meta?.code).toBe("unauthorized");
    expect(meta?.retry_hint).toBe("do_not_retry");
    expect(meta?.status).toBe(401);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Artifacta authentication failed");
    expect(text).toContain("Invalid API key");
    expect(text).toContain("https://app.artifacta.io/dashboard/keys");
  });

  it("subsequent unauthorized error after a successful whoami includes ****<last4>", async () => {
    // 1) Successful whoami populates cache.
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: VALID_BODY,
    } satisfies HttpResult);
    await whoamiHandler();

    // 2) Subsequent unauthorized failure surfaces the cached suffix.
    mockRequest.mockResolvedValueOnce({
      ok: false,
      status: 401,
      error: { code: "unauthorized", message: "rotated", status: 401 },
      attempts: 1,
    } satisfies HttpResult);
    const result = await whoamiHandler();
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("****abcd");
  });
});

// ─── Resource: artifacta://whoami ────────────────────────────────────────────

describe("AF_MCP-2.1 — artifacta://whoami resource", () => {
  it("registers a Resource entry with mimeType 'application/json'", () => {
    expect(WHOAMI_RESOURCE.uri).toBe("artifacta://whoami");
    expect(WHOAMI_RESOURCE.mimeType).toBe("application/json");
    const all = listResources();
    const entry = all.find((r) => r.uri === WHOAMI_RESOURCE_URI);
    expect(entry).toBeDefined();
    expect(entry!.mimeType).toBe("application/json");
    expect(entry!.name).toBe("whoami");
  });

  it("resources/list always includes the whoami entry", () => {
    // Even with no other registrations, whoami should be present.
    expect(listResources().map((r) => r.uri)).toContain(WHOAMI_RESOURCE_URI);
  });

  it("resources/read returns the same JSON the tool would, as a TextResourceContents", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: VALID_BODY,
    } satisfies HttpResult);
    const reader = getResourceReader(WHOAMI_RESOURCE_URI);
    expect(reader).toBeDefined();
    const result = await reader!(WHOAMI_RESOURCE_URI);
    expect(result.contents).toHaveLength(1);
    const c = result.contents[0] as {
      uri: string;
      mimeType?: string;
      text: string;
    };
    expect(c.uri).toBe(WHOAMI_RESOURCE_URI);
    expect(c.mimeType).toBe("application/json");
    expect(JSON.parse(c.text)).toEqual(VALID_BODY);
  });

  it("populates the auth cache when the resource read succeeds", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { ...VALID_BODY, api_key_last_4: "wxyz" },
    } satisfies HttpResult);
    const reader = getResourceReader(WHOAMI_RESOURCE_URI)!;
    await reader(WHOAMI_RESOURCE_URI);
    const t = translateHttpFailure(
      {
        ok: false,
        status: 401,
        error: { code: "unauthorized", message: "x", status: 401 },
        attempts: 1,
      },
      "any"
    );
    const text = (t.content[0] as { text: string }).text;
    expect(text).toContain("****wxyz");
  });

  it("throws McpError when the underlying API call fails with unauthorized", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: false,
      status: 401,
      error: { code: "unauthorized", message: "bad key", status: 401 },
      attempts: 1,
    } satisfies HttpResult);
    const reader = getResourceReader(WHOAMI_RESOURCE_URI)!;
    await expect(reader(WHOAMI_RESOURCE_URI)).rejects.toMatchObject({
      message: expect.stringContaining("Artifacta authentication failed"),
    });
  });

  it("does not populate the cache when the resource read fails", async () => {
    // Pre-seed cache with a known value, then ensure a failed read leaves it
    // alone (overwriting with a stale value would defeat AF_MCP-1.4).
    cacheKeySuffix("seed");
    mockRequest.mockResolvedValueOnce({
      ok: false,
      status: 401,
      error: { code: "unauthorized", message: "no", status: 401 },
      attempts: 1,
    } satisfies HttpResult);
    const reader = getResourceReader(WHOAMI_RESOURCE_URI)!;
    await expect(reader(WHOAMI_RESOURCE_URI)).rejects.toBeDefined();
    const t = translateHttpFailure(
      {
        ok: false,
        status: 401,
        error: { code: "unauthorized", message: "x", status: 401 },
        attempts: 1,
      },
      "any"
    );
    const text = (t.content[0] as { text: string }).text;
    expect(text).toContain("****seed");
  });
});
