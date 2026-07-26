// AG-07 — OAuth JWT validation + scope gating over POST /mcp (unit, offline).
//
// Mints ES256 access tokens locally with jose and verifies them against an
// INJECTED key (no network — the unit suite is offline with low timeouts). Two
// stub APIs prove the routing split: `ak_live_` traffic hits the PUBLIC stub
// with the API key; OAuth traffic hits the INTERNAL stub with the cross-tenant
// secret + tenant/scope headers and never the JWT.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { SignJWT, generateKeyPair } from "jose";
import {
  startHttpServer,
  type StartedHttpServer,
} from "../src/http/transport.js";
import { createOAuthVerifier } from "../src/http/oauth.js";
import { clearRevocations, revokeConnection } from "../src/http/revocation.js";
import { registerAllTools, registerAllResources } from "../src/tools/index.js";
import { clearRegistry } from "../src/safety/registry.js";
import { clearResourceRegistry } from "../src/resources/registry.js";
import { startStubServer, type StartedStub } from "./integration/stub-server.js";
import {
  setLogWriter,
  resetLogWriter,
  setLogLevel,
  resetLogger,
} from "../src/log/logger.js";

const AUDIENCE = "https://mcp.test/mcp";
const TENANT = "tenant-abc";
const CLIENT_ID = "mcp-client-1";
const INTERNAL_SECRET = "internal-secret-value-xyz";
const VALID_KEY = "ak_live_0123456789abcdefghijklmnopqrstuv";
const ARTIFACT_ID = "art_0123456789abcdef";

const READ_TOOLS = [
  "whoami",
  "list_artifacts",
  "get_artifact",
  "get_artifact_download_url",
  "list_sessions",
];
const WRITE_TOOLS = ["store_artifact", "request_upload_url", "complete_upload", "publish_artifact", "unpublish_artifact"];
const DESTROY_TOOLS = ["create_download_link", "delete_artifact", "seal_session"];

type Keys = Awaited<ReturnType<typeof generateKeyPair>>;
let keys: Keys; // the verifier's key
let wrongKeys: Keys; // a different key — for the bad-signature case

let started: StartedHttpServer; // OAuth + internal configured
let publicStub: StartedStub;
let internalStub: StartedStub;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

interface MintOpts {
  signWith?: Keys;
  audience?: string;
  scope?: string;
  tenantId?: string | null; // null → omit the claim
  clientId?: string | null; // null → omit the claim
  iat?: number;
  exp?: number;
  omitExp?: boolean; // skip setExpirationTime entirely (finding #1)
  omitIat?: boolean; // skip setIssuedAt entirely (finding #1)
}

async function mint(opts: MintOpts = {}): Promise<string> {
  const claims: Record<string, unknown> = {};
  if (opts.scope !== undefined) claims.scope = opts.scope;
  if (opts.tenantId !== null) claims.tenant_id = opts.tenantId ?? TENANT;
  if (opts.clientId !== null) claims.client_id = opts.clientId ?? CLIENT_ID;

  let signer = new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid: "test-kid" })
    .setAudience(opts.audience ?? AUDIENCE);
  if (!opts.omitIat) signer = signer.setIssuedAt(opts.iat ?? nowSec());
  if (!opts.omitExp) signer = signer.setExpirationTime(opts.exp ?? nowSec() + 3600);
  return signer.sign((opts.signWith ?? keys).privateKey);
}

function mcpBody(method: string, params: unknown, id = 1): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

function postBearer(token: string, body: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${started.port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    body,
  });
}

interface RpcEnvelope<T> {
  jsonrpc: string;
  id: number;
  result?: T;
}
interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

const INIT = {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "ag-07", version: "0.0.0" },
};

const WHOAMI_BODY = JSON.stringify({
  tenant_name: "oauth-tenant",
  plan: "free",
  api_key_last_4: "oaut",
  usage_requests_month: 1,
  plan_requests_limit_month: 1000,
  usage_storage_bytes: 0,
  plan_storage_limit_bytes: 1_000_000,
});

beforeAll(async () => {
  setLogWriter(() => {});
  keys = await generateKeyPair("ES256");
  wrongKeys = await generateKeyPair("ES256");

  clearRegistry();
  clearResourceRegistry();
  registerAllTools();
  registerAllResources();

  const whoami = () => ({ status: 200, body: WHOAMI_BODY });
  publicStub = await startStubServer({ "GET /v1/whoami": whoami });
  internalStub = await startStubServer({
    "GET /v1/whoami": whoami,
    "POST /v1/artifacts/upload-url": () => ({
      status: 200,
      body: JSON.stringify({
        artifact_id: ARTIFACT_ID,
        status: "pending",
        upload_url: "https://r2.example/put",
        upload_expires_at: "2026-06-20T01:00:00Z",
        upload_method: "PUT",
        upload_headers: {},
      }),
    }),
    [`DELETE /v1/artifacts/${ARTIFACT_ID}`]: () => ({
      status: 200,
      body: JSON.stringify({ artifact_id: ARTIFACT_ID, deleted: true }),
    }),
  });

  const verifier = createOAuthVerifier({ keyInput: keys.publicKey, audience: AUDIENCE });

  started = await startHttpServer({
    port: 0,
    config: { apiKey: undefined, apiUrl: publicStub.url },
    allowedOrigins: [],
    resourceUri: AUDIENCE,
    oauthVerifier: verifier,
    internalApiUrl: internalStub.url,
    internalSecret: INTERNAL_SECRET,
  });
});

afterAll(async () => {
  await started.close();
  await publicStub.close();
  await internalStub.close();
  clearRegistry();
  clearResourceRegistry();
  clearRevocations();
  resetLogWriter();
});

beforeEach(() => {
  clearRevocations();
});

describe("AG-07 invalid JWTs → 401", () => {
  it("wrong audience", async () => {
    const t = await mint({ audience: "https://wrong.example/mcp", scope: "artifacts:read" });
    const res = await postBearer(t, mcpBody("initialize", INIT));
    expect(res.status).toBe(401);
  });

  it("expired", async () => {
    const t = await mint({ scope: "artifacts:read", iat: nowSec() - 7200, exp: nowSec() - 3600 });
    const res = await postBearer(t, mcpBody("initialize", INIT));
    expect(res.status).toBe(401);
  });

  it("bad signature (signed by a different key)", async () => {
    const t = await mint({ signWith: wrongKeys, scope: "artifacts:read" });
    const res = await postBearer(t, mcpBody("initialize", INIT));
    expect(res.status).toBe(401);
  });

  it("garbage (not a JWT)", async () => {
    const res = await postBearer("not-a-jwt", mcpBody("initialize", INIT));
    expect(res.status).toBe(401);
  });

  it("valid signature but missing tenant_id → 401", async () => {
    const t = await mint({ tenantId: null, scope: "artifacts:read" });
    const res = await postBearer(t, mcpBody("initialize", INIT));
    expect(res.status).toBe(401);
  });

  // Finding #1: a token that omits `exp` must NOT validate (jose only checks exp
  // when present; requiredClaims:["exp","iat"] closes the fail-open).
  it("missing exp claim → 401 (no never-expiring tokens)", async () => {
    const t = await mint({ scope: "artifacts:destroy", omitExp: true });
    const res = await postBearer(t, mcpBody("initialize", INIT));
    expect(res.status).toBe(401);
  });

  it("missing iat claim → 401 (revocation keys on iat)", async () => {
    const t = await mint({ scope: "artifacts:read", omitIat: true });
    const res = await postBearer(t, mcpBody("initialize", INIT));
    expect(res.status).toBe(401);
  });

  it("the 401 carries the RFC 9728 challenge", async () => {
    const res = await postBearer("not-a-jwt", mcpBody("initialize", INIT));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
  });
});

describe("AG-07 read token", () => {
  it("tools/list advertises all 13 tools (out-of-scope tools are call-gated, not hidden)", async () => {
    const t = await mint({ scope: "artifacts:read" });
    const res = await postBearer(t, mcpBody("tools/list", {}, 2));
    expect(res.status).toBe(200);
    const body = (await res.json()) as RpcEnvelope<{ tools: Array<{ name: string }> }>;
    const names = body.result!.tools.map((x) => x.name);
    expect(new Set(names)).toEqual(new Set([...READ_TOOLS, ...WRITE_TOOLS, ...DESTROY_TOOLS]));
    expect(names).toHaveLength(13);
  });

  it("resources/list is non-empty (read grants resources)", async () => {
    const t = await mint({ scope: "artifacts:read" });
    const res = await postBearer(t, mcpBody("resources/list", {}, 3));
    const body = (await res.json()) as RpcEnvelope<{ resources: unknown[] }>;
    expect(body.result!.resources.length).toBeGreaterThan(0);
  });

  it("whoami routes through the INTERNAL API with no JWT passthrough", async () => {
    const t = await mint({ scope: "artifacts:read" });
    const beforeInternal = internalStub.requestLog.length;
    const beforePublic = publicStub.requestLog.length;
    const res = await postBearer(t, mcpBody("tools/call", { name: "whoami", arguments: {} }, 4));
    expect(res.status).toBe(200);
    const body = (await res.json()) as RpcEnvelope<ToolResult>;
    expect(body.result!.isError).toBeFalsy();

    const call = internalStub.requestLog
      .slice(beforeInternal)
      .find((r) => r.method === "GET" && r.path === "/v1/whoami");
    expect(call).toBeDefined();
    // Internal secret + tenant/scope headers; the JWT is NOT forwarded.
    expect(call!.headers["authorization"]).toBe(`Bearer ${INTERNAL_SECRET}`);
    expect(call!.headers["x-artifacta-tenant-id"]).toBe(TENANT);
    expect(call!.headers["x-artifacta-scope"]).toContain("artifacts:read");
    for (const v of Object.values(call!.headers)) {
      expect(v).not.toContain(t); // the raw JWT appears nowhere
    }
    // The public API saw nothing for this OAuth call.
    expect(publicStub.requestLog.length).toBe(beforePublic);
  });

  it("a write tool call is scope-denied, naming artifacts:write", async () => {
    const t = await mint({ scope: "artifacts:read" });
    const res = await postBearer(
      t,
      mcpBody("tools/call", { name: "request_upload_url", arguments: { filename: "a", content_type: "text/plain", size_bytes: 1 } }, 5)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as RpcEnvelope<ToolResult>;
    expect(body.result!.isError).toBe(true);
    expect(body.result!.content[0].text).toContain("artifacts:write");
    expect(body.result!._meta?.code).toBe("insufficient_scope");
  });

  it("a destroy tool call is scope-denied, naming artifacts:destroy", async () => {
    const t = await mint({ scope: "artifacts:read" });
    const res = await postBearer(
      t,
      mcpBody("tools/call", { name: "delete_artifact", arguments: { artifact_id: ARTIFACT_ID } }, 6)
    );
    const body = (await res.json()) as RpcEnvelope<ToolResult>;
    expect(body.result!.isError).toBe(true);
    expect(body.result!.content[0].text).toContain("artifacts:destroy");
  });
});

describe("AG-07 read+write token", () => {
  it("tools/list advertises all 13 tools (destroy tools visible but call-gated)", async () => {
    const t = await mint({ scope: "artifacts:read artifacts:write" });
    const res = await postBearer(t, mcpBody("tools/list", {}, 7));
    const body = (await res.json()) as RpcEnvelope<{ tools: Array<{ name: string }> }>;
    const names = body.result!.tools.map((x) => x.name);
    expect(names).toHaveLength(13);
    expect(names.some((n) => DESTROY_TOOLS.includes(n))).toBe(true);
  });

  it("a write tool reaches the internal API with internal headers, not the JWT", async () => {
    const t = await mint({ scope: "artifacts:read artifacts:write" });
    const before = internalStub.requestLog.length;
    const res = await postBearer(
      t,
      mcpBody("tools/call", { name: "request_upload_url", arguments: { filename: "big.bin", content_type: "application/octet-stream", size_bytes: 600_000_000 } }, 8)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as RpcEnvelope<ToolResult>;
    expect(body.result!.isError).toBeFalsy();
    const call = internalStub.requestLog
      .slice(before)
      .find((r) => r.method === "POST" && r.path === "/v1/artifacts/upload-url");
    expect(call).toBeDefined();
    expect(call!.headers["authorization"]).toBe(`Bearer ${INTERNAL_SECRET}`);
    expect(call!.headers["x-artifacta-scope"]).toContain("artifacts:write");
    for (const v of Object.values(call!.headers)) expect(v).not.toContain(t);
  });

  it("a destroy tool call is still scope-denied", async () => {
    const t = await mint({ scope: "artifacts:read artifacts:write" });
    const res = await postBearer(
      t,
      mcpBody("tools/call", { name: "delete_artifact", arguments: { artifact_id: ARTIFACT_ID } }, 9)
    );
    const body = (await res.json()) as RpcEnvelope<ToolResult>;
    expect(body.result!.isError).toBe(true);
    expect(body.result!.content[0].text).toContain("artifacts:destroy");
  });
});

describe("AG-07 read+write+destroy token", () => {
  it("tools/list exposes all 13 tools", async () => {
    const t = await mint({ scope: "artifacts:read artifacts:write artifacts:destroy" });
    const res = await postBearer(t, mcpBody("tools/list", {}, 10));
    const body = (await res.json()) as RpcEnvelope<{ tools: Array<{ name: string }> }>;
    expect(body.result!.tools).toHaveLength(13);
  });

  it("delete_artifact reaches the internal API (not scope-denied)", async () => {
    const t = await mint({ scope: "artifacts:read artifacts:write artifacts:destroy" });
    const before = internalStub.requestLog.length;
    const res = await postBearer(
      t,
      mcpBody("tools/call", { name: "delete_artifact", arguments: { artifact_id: ARTIFACT_ID, confirm: true } }, 11)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as RpcEnvelope<ToolResult>;
    expect(body.result!.isError).toBeFalsy();
    const call = internalStub.requestLog
      .slice(before)
      .find((r) => r.method === "DELETE" && r.path === `/v1/artifacts/${ARTIFACT_ID}`);
    expect(call).toBeDefined();
    expect(call!.headers["x-artifacta-scope"]).toContain("artifacts:destroy");
  });
});

describe("AG-07 empty/garbage scope grant", () => {
  it("a token with only OIDC scopes still sees the tool list but every call is denied", async () => {
    const t = await mint({ scope: "openid profile email" });
    const list = await postBearer(t, mcpBody("tools/list", {}, 12));
    const listBody = (await list.json()) as RpcEnvelope<{ tools: unknown[] }>;
    expect(listBody.result!.tools).toHaveLength(13);

    const resList = await postBearer(t, mcpBody("resources/list", {}, 13));
    const resBody = (await resList.json()) as RpcEnvelope<{ resources: unknown[] }>;
    expect(resBody.result!.resources).toHaveLength(0);

    // Even whoami (a read tool) is scope-denied, naming artifacts:read.
    const call = await postBearer(t, mcpBody("tools/call", { name: "whoami", arguments: {} }, 14));
    const callBody = (await call.json()) as RpcEnvelope<ToolResult>;
    expect(callBody.result!.isError).toBe(true);
    expect(callBody.result!.content[0].text).toContain("artifacts:read");
  });
});

describe("AG-10 revocation through the verifier", () => {
  it("revoking (client_id, tenant_id) rejects older tokens but accepts newer ones", async () => {
    const oldToken = await mint({ scope: "artifacts:read", iat: nowSec() - 600 });
    // Sanity: works before revocation.
    const ok = await postBearer(oldToken, mcpBody("tools/list", {}, 15));
    expect(ok.status).toBe(200);

    // Revoke everything up to now.
    revokeConnection(CLIENT_ID, TENANT, nowSec());

    const rejected = await postBearer(oldToken, mcpBody("tools/list", {}, 16));
    expect(rejected.status).toBe(401);

    // A token minted after the cutoff still validates.
    const newToken = await mint({ scope: "artifacts:read", iat: nowSec() + 5 });
    const accepted = await postBearer(newToken, mcpBody("tools/list", {}, 17));
    expect(accepted.status).toBe(200);
  });
});

describe("AG-07 ak_live_ regression with OAuth configured", () => {
  it("an ak_live_ bearer still sees all tools and hits the PUBLIC API with no internal headers", async () => {
    const beforePublic = publicStub.requestLog.length;
    const beforeInternal = internalStub.requestLog.length;
    const list = await postBearer(VALID_KEY, mcpBody("tools/list", {}, 18));
    const listBody = (await list.json()) as RpcEnvelope<{ tools: unknown[] }>;
    expect(listBody.result!.tools).toHaveLength(13);

    const call = await postBearer(VALID_KEY, mcpBody("tools/call", { name: "whoami", arguments: {} }, 19));
    expect(call.status).toBe(200);
    const callBody = (await call.json()) as RpcEnvelope<ToolResult>;
    expect(callBody.result!.isError).toBeFalsy();

    const pub = publicStub.requestLog
      .slice(beforePublic)
      .find((r) => r.method === "GET" && r.path === "/v1/whoami");
    expect(pub).toBeDefined();
    expect(pub!.headers["authorization"]).toBe(`Bearer ${VALID_KEY}`);
    expect(Object.keys(pub!.headers).some((k) => k.startsWith("x-artifacta-"))).toBe(false);
    // The internal API saw nothing for the ak_live_ call.
    expect(internalStub.requestLog.length).toBe(beforeInternal);
  });
});

describe("AG-07 no-secret logging for OAuth credentials", () => {
  it("never writes the Supabase JWT or MCP_INTERNAL_SECRET to logs", async () => {
    const t = await mint({ scope: "artifacts:read" });
    const logs: string[] = [];
    setLogLevel("debug");
    setLogWriter((line) => logs.push(line));
    try {
      const res = await postBearer(t, mcpBody("tools/call", { name: "whoami", arguments: {} }, 21));
      expect(res.status).toBe(200);
      await res.json();
    } finally {
      // resetLogger first (restores default level + writer), then re-silence so
      // the remaining cases keep the beforeAll noop writer.
      resetLogger();
      setLogWriter(() => {});
    }
    const joined = logs.join("\n");
    expect(joined).not.toContain(t); // the raw JWT
    expect(joined).not.toContain(INTERNAL_SECRET); // the cross-tenant secret
  });
});

describe("AG-07 fail-closed when the internal path is unconfigured", () => {
  it("an OAuth token gets 500 (never forwarded) when internalApiUrl/secret are missing", async () => {
    const misconfigured = await startHttpServer({
      port: 0,
      config: { apiKey: undefined, apiUrl: publicStub.url },
      allowedOrigins: [],
      resourceUri: AUDIENCE,
      oauthVerifier: createOAuthVerifier({ keyInput: keys.publicKey, audience: AUDIENCE }),
      // internalApiUrl / internalSecret intentionally omitted
    });
    try {
      const t = await mint({ scope: "artifacts:read" });
      const beforePublic = publicStub.requestLog.length;
      const res = await fetch(`http://127.0.0.1:${misconfigured.port}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${t}` },
        body: mcpBody("tools/call", { name: "whoami", arguments: {} }, 20),
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("server_error");
      // The JWT was never forwarded anywhere.
      expect(publicStub.requestLog.length).toBe(beforePublic);
    } finally {
      await misconfigured.close();
    }
  });
});

describe("AG-07 client binding (finding #2)", () => {
  // A verifier configured with an expected client_id must reject tokens from any
  // other OAuth client (cross-client substitution) and tokens with no client_id.
  let bound: StartedHttpServer;
  const EXPECTED = "the-registered-mcp-client";

  beforeAll(async () => {
    bound = await startHttpServer({
      port: 0,
      config: { apiKey: undefined, apiUrl: publicStub.url },
      allowedOrigins: [],
      resourceUri: AUDIENCE,
      oauthVerifier: createOAuthVerifier({
        keyInput: keys.publicKey,
        audience: AUDIENCE,
        expectedClientId: EXPECTED,
      }),
      internalApiUrl: internalStub.url,
      internalSecret: INTERNAL_SECRET,
    });
  });
  afterAll(async () => {
    await bound.close();
  });

  function postBound(token: string, id: number): Promise<Response> {
    return fetch(`http://127.0.0.1:${bound.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${token}` },
      body: mcpBody("tools/list", {}, id),
    });
  }

  it("accepts a token from the registered client", async () => {
    const t = await mint({ scope: "artifacts:read", clientId: EXPECTED });
    expect((await postBound(t, 22)).status).toBe(200);
  });

  it("rejects a token minted by a DIFFERENT OAuth client (cross-client substitution)", async () => {
    const t = await mint({ scope: "artifacts:destroy", clientId: "some-other-client" });
    expect((await postBound(t, 23)).status).toBe(401);
  });

  it("rejects a token with no client_id claim", async () => {
    const t = await mint({ scope: "artifacts:read", clientId: null });
    expect((await postBound(t, 24)).status).toBe(401);
  });

  // AG-DCR-01 hardening: the client_id/azp consistency guard is UNCONDITIONAL —
  // it fires even in strict (non-DCR) mode, ahead of the expectedClientId match.
  // client_id == EXPECTED but azp == a different id is ambiguous → 401, NOT a pass.
  it("rejects a token whose client_id matches but azp differs (ambiguous, even in strict mode)", async () => {
    const t = await new SignJWT({
      tenant_id: TENANT,
      client_id: EXPECTED,
      azp: "some-other-client",
      scope: "artifacts:read",
    })
      .setProtectedHeader({ alg: "ES256", kid: "test-kid" })
      .setAudience(AUDIENCE)
      .setIssuedAt(nowSec())
      .setExpirationTime(nowSec() + 3600)
      .sign(keys.privateKey);
    expect((await postBound(t, 25)).status).toBe(401);
  });
});

describe("AG-DCR-02 DCR mode (client binding relaxed to presence + aud)", () => {
  // With DCR, client ids are per-client and unknown. The verifier accepts ANY
  // present client_id as long as `aud` == MCP_RESOURCE_URI (enforced by jose) — the
  // cross-client gate moves to the hook (which stamps aud=MCP only for a recognized
  // client). A token with no client_id is rejected; a wrong aud is rejected.
  let dcr: StartedHttpServer;

  beforeAll(async () => {
    dcr = await startHttpServer({
      port: 0,
      config: { apiKey: undefined, apiUrl: publicStub.url },
      allowedOrigins: [],
      resourceUri: AUDIENCE,
      // dcrEnabled relaxes the binding; no expectedClientId is set in DCR mode.
      oauthVerifier: createOAuthVerifier({
        keyInput: keys.publicKey,
        audience: AUDIENCE,
        dcrEnabled: true,
      }),
      internalApiUrl: internalStub.url,
      internalSecret: INTERNAL_SECRET,
    });
  });
  afterAll(async () => {
    await dcr.close();
  });

  function postDcr(token: string, id: number): Promise<Response> {
    return fetch(`http://127.0.0.1:${dcr.port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${token}` },
      body: mcpBody("tools/list", {}, id),
    });
  }

  it("accepts a token from an arbitrary dynamic client (any present client_id + correct aud)", async () => {
    const t = await mint({ scope: "artifacts:read", clientId: "dynamic-client-abc123" });
    expect((await postDcr(t, 30)).status).toBe(200);
  });

  it("accepts a DIFFERENT dynamic client too (binding is not pinned to one id)", async () => {
    const t = await mint({ scope: "artifacts:read", clientId: "another-dynamic-client-xyz" });
    expect((await postDcr(t, 31)).status).toBe(200);
  });

  it("accepts a token whose client id is carried by azp only", async () => {
    // azp present, client_id omitted → the verifier reads azp.
    const withAzp = await new SignJWT({ tenant_id: TENANT, azp: "azp-dynamic-client", scope: "artifacts:read" })
      .setProtectedHeader({ alg: "ES256", kid: "test-kid" })
      .setAudience(AUDIENCE)
      .setIssuedAt(nowSec())
      .setExpirationTime(nowSec() + 3600)
      .sign(keys.privateKey);
    expect((await postDcr(withAzp, 32)).status).toBe(200);
  });

  it("rejects a token with NO client_id and NO azp (not an OAuth-client token)", async () => {
    const t = await mint({ scope: "artifacts:read", clientId: null });
    expect((await postDcr(t, 33)).status).toBe(401);
  });

  // AG-DCR-01 hardening (adversarial review): an ambiguous token carrying BOTH
  // client_id AND azp with DIFFERENT values is rejected (the hook would recognize
  // on one claim while the verifier binds identity/revocation to the other). The
  // mint() helper only ever sets client_id, so build the JWT inline (as the azp
  // test does) to carry both claims.
  it("rejects a token with client_id and azp both present and DIFFERENT (ambiguous → 401)", async () => {
    const mismatched = await new SignJWT({
      tenant_id: TENANT,
      client_id: "dynamic-client-abc123",
      azp: "a-different-dynamic-client",
      scope: "artifacts:read",
    })
      .setProtectedHeader({ alg: "ES256", kid: "test-kid" })
      .setAudience(AUDIENCE)
      .setIssuedAt(nowSec())
      .setExpirationTime(nowSec() + 3600)
      .sign(keys.privateKey);
    expect((await postDcr(mismatched, 38)).status).toBe(401);
  });

  it("accepts a token with client_id and azp both present and EQUAL (normal Supabase shape → 200)", async () => {
    const matched = await new SignJWT({
      tenant_id: TENANT,
      client_id: "dynamic-client-abc123",
      azp: "dynamic-client-abc123",
      scope: "artifacts:read",
    })
      .setProtectedHeader({ alg: "ES256", kid: "test-kid" })
      .setAudience(AUDIENCE)
      .setIssuedAt(nowSec())
      .setExpirationTime(nowSec() + 3600)
      .sign(keys.privateKey);
    expect((await postDcr(matched, 39)).status).toBe(200);
  });

  it("rejects a wrong audience even in DCR mode", async () => {
    const t = await mint({ scope: "artifacts:read", clientId: "dynamic-client-abc123", audience: "https://wrong.example/mcp" });
    expect((await postDcr(t, 34)).status).toBe(401);
  });

  it("still advertises all tools in DCR mode (scope enforcement is at call time)", async () => {
    const t = await mint({ scope: "artifacts:read", clientId: "dynamic-client-abc123" });
    const res = await postDcr(t, 35);
    const body = (await res.json()) as RpcEnvelope<{ tools: Array<{ name: string }> }>;
    expect(body.result!.tools).toHaveLength(13);
  });

  it("prod config (dcrEnabled + expectedClientId both set, parallel support): an arbitrary client still validates", async () => {
    // Prod runs MCP_OAUTH_CLIENT_ID=<fixed> (kept for the fixed-client OR-branch) AND
    // MCP_OAUTH_DCR_ENABLED=1. The DCR arm must win — a dynamic client whose id is NOT
    // the fixed one must still validate (the exact-match check is never reached).
    const server = await startHttpServer({
      port: 0,
      config: { apiKey: undefined, apiUrl: publicStub.url },
      allowedOrigins: [],
      resourceUri: AUDIENCE,
      oauthVerifier: createOAuthVerifier({
        keyInput: keys.publicKey,
        audience: AUDIENCE,
        expectedClientId: "the-fixed-client",
        dcrEnabled: true,
      }),
      internalApiUrl: internalStub.url,
      internalSecret: INTERNAL_SECRET,
    });
    try {
      const dynamic = await mint({ scope: "artifacts:read", clientId: "some-other-dynamic-client" });
      expect(
        (await fetch(`http://127.0.0.1:${server.port}/mcp`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${dynamic}` },
          body: mcpBody("tools/list", {}, 36),
        })).status
      ).toBe(200);
      // The fixed client still works too (it just isn't required to match).
      const fixed = await mint({ scope: "artifacts:read", clientId: "the-fixed-client" });
      expect(
        (await fetch(`http://127.0.0.1:${server.port}/mcp`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${fixed}` },
          body: mcpBody("tools/list", {}, 37),
        })).status
      ).toBe(200);
    } finally {
      await server.close();
    }
  });
});
