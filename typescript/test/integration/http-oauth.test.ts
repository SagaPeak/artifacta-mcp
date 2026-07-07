// AG-07 / AG-10 — hosted HTTP OAuth integration over POST /mcp.
//
// Counterpart to the unit test/http-oauth.test.ts: this drives the PRODUCTION
// wiring — createRemoteOAuthVerifier fetching a JWKS over HTTP (createRemoteJWKSet)
// — against a local stub JWKS endpoint and a stub internal API. It proves, end
// to end on the real transport: audience rejection, scope gating, the
// no-JWT-passthrough invariant (OAuth → internal API with the cross-tenant
// secret), the `ak_live_` regression, and revocation. No staging required
// (local stubs), so it runs on every `npm run test:integration`.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SignJWT, generateKeyPair, exportJWK } from "jose";
import {
  startHttpServer,
  type StartedHttpServer,
} from "../../src/http/transport.js";
import { createRemoteOAuthVerifier } from "../../src/http/oauth.js";
import { revokeConnection, clearRevocations } from "../../src/http/revocation.js";
import { registerAllTools, registerAllResources } from "../../src/tools/index.js";
import { clearRegistry, getFilteredTools } from "../../src/safety/registry.js";
import { requiredScopeForTool, SCOPE_DESTROY } from "../../src/safety/scopes.js";
import { clearResourceRegistry } from "../../src/resources/registry.js";
import { startStubServer, type StartedStub } from "./stub-server.js";
import { setLogWriter, resetLogWriter } from "../../src/log/logger.js";

const AUDIENCE = "https://mcp.test/mcp";
const TENANT = "tenant-integration";
const CLIENT_ID = "mcp-client-int";
const INTERNAL_SECRET = "integration-internal-secret";
const VALID_KEY = "ak_live_0123456789abcdefghijklmnopqrstuv";
const KID = "integration-kid";

/**
 * All tool names currently in the safety registry (populated by
 * registerAllTools() in beforeAll), sorted. hasConfirmations: true with
 * allowDestructive: true returns every registration unfiltered.
 */
function registeredToolNames(): string[] {
  return getFilteredTools({
    hasConfirmations: true,
    allowDestructive: true,
    writeConfirmRequired: false,
  })
    .map((tool) => tool.name)
    .sort();
}
const ACCEPT = "application/json, text/event-stream";

type Keys = Awaited<ReturnType<typeof generateKeyPair>>;
let keys: Keys;
let started: StartedHttpServer;
let publicStub: StartedStub;
let internalStub: StartedStub;
let jwksStub: StartedStub;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

async function mint(opts: { scope?: string; audience?: string; iat?: number } = {}): Promise<string> {
  return new SignJWT({
    scope: opts.scope ?? "artifacts:read",
    tenant_id: TENANT,
    client_id: CLIENT_ID,
  })
    .setProtectedHeader({ alg: "ES256", kid: KID })
    .setIssuedAt(opts.iat ?? nowSec())
    .setExpirationTime(nowSec() + 3600)
    .setAudience(opts.audience ?? AUDIENCE)
    .sign(keys.privateKey);
}

function post(token: string, body: unknown, id = 1): Promise<Response> {
  return fetch(`http://127.0.0.1:${started.port}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: ACCEPT,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, ...(body as object) }),
  });
}

interface RpcEnvelope<T> {
  result?: T;
}
interface ToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

beforeAll(async () => {
  setLogWriter(() => {});
  clearRegistry();
  clearResourceRegistry();
  clearRevocations();
  registerAllTools();
  registerAllResources();

  // Extractable keys so we can publish the public JWK in the JWKS document.
  keys = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(keys.publicKey);
  const jwksDoc = JSON.stringify({
    keys: [{ ...jwk, kid: KID, alg: "ES256", use: "sig" }],
  });
  jwksStub = await startStubServer({
    "GET /jwks": () => ({ status: 200, body: jwksDoc }),
  });

  publicStub = await startStubServer({
    "GET /v1/whoami": () => ({ status: 200, body: WHOAMI_BODY }),
  });
  internalStub = await startStubServer({
    "GET /v1/whoami": () => ({ status: 200, body: WHOAMI_BODY }),
    "POST /v1/artifacts/upload-url": () => ({
      status: 200,
      body: JSON.stringify({
        artifact_id: "art_0123456789abcdef",
        status: "pending",
        upload_url: "https://r2.example/put",
        upload_expires_at: "2026-06-20T01:00:00Z",
        upload_method: "PUT",
        upload_headers: {},
      }),
    }),
  });

  const verifier = createRemoteOAuthVerifier({
    jwksUrl: `${jwksStub.url}/jwks`,
    audience: AUDIENCE,
  });

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

const WHOAMI_BODY = JSON.stringify({
  tenant_name: "oauth-tenant",
  plan: "free",
  api_key_last_4: "oaut",
  usage_requests_month: 1,
  plan_requests_limit_month: 1000,
  usage_storage_bytes: 0,
  plan_storage_limit_bytes: 1_000_000,
});

afterAll(async () => {
  await started.close();
  await publicStub.close();
  await internalStub.close();
  await jwksStub.close();
  clearRegistry();
  clearResourceRegistry();
  clearRevocations();
  resetLogWriter();
});

describe("AG-07 integration — remote JWKS validation + scope gating", () => {
  it("a read+write token (validated via remote JWKS) lists every registered non-destroy tool", async () => {
    const t = await mint({ scope: "artifacts:read artifacts:write" });
    const res = await post(t, { method: "tools/list", params: {} }, 1);
    expect(res.status).toBe(200);
    const body = (await res.json()) as RpcEnvelope<{ tools: Array<{ name: string }> }>;
    // Derive the expectation from the safety registry instead of a hardcoded
    // count, so adding a tool doesn't silently break the nightly suite. The
    // registry's safety classes are themselves pinned by
    // test/http-oauth-scopes.test.ts, so this stays non-circular.
    const listed = body.result!.tools.map((tool) => tool.name).sort();
    const expected = registeredToolNames().filter(
      (name) => requiredScopeForTool(name) !== SCOPE_DESTROY,
    );
    expect(listed).toEqual(expected);
    expect(listed.length).toBeGreaterThan(0);
    for (const destroyTool of ["create_download_link", "delete_artifact", "seal_session"]) {
      expect(listed).not.toContain(destroyTool);
    }
  });

  it("a write tool reaches the INTERNAL API with internal headers and no JWT", async () => {
    const t = await mint({ scope: "artifacts:read artifacts:write" });
    const before = internalStub.requestLog.length;
    const res = await post(
      t,
      {
        method: "tools/call",
        params: {
          name: "request_upload_url",
          arguments: { filename: "big.bin", content_type: "application/octet-stream", size_bytes: 600_000_000 },
        },
      },
      2
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as RpcEnvelope<ToolResult>;
    expect(body.result!.isError).toBeFalsy();
    const call = internalStub.requestLog
      .slice(before)
      .find((r) => r.method === "POST" && r.path === "/v1/artifacts/upload-url");
    expect(call).toBeDefined();
    expect(call!.headers["authorization"]).toBe(`Bearer ${INTERNAL_SECRET}`);
    expect(call!.headers["x-artifacta-tenant-id"]).toBe(TENANT);
    expect(call!.headers["x-artifacta-scope"]).toContain("artifacts:write");
    for (const v of Object.values(call!.headers)) expect(v).not.toContain(t);
  });

  it("a read token cannot call a destroy tool (scope-denied, names artifacts:destroy)", async () => {
    const t = await mint({ scope: "artifacts:read" });
    const res = await post(
      t,
      { method: "tools/call", params: { name: "delete_artifact", arguments: { artifact_id: "art_0123456789abcdef" } } },
      3
    );
    const body = (await res.json()) as RpcEnvelope<ToolResult>;
    expect(body.result!.isError).toBe(true);
    expect(body.result!.content[0].text).toContain("artifacts:destroy");
  });

  it("a wrong-audience token is rejected with 401", async () => {
    const t = await mint({ scope: "artifacts:read", audience: "https://wrong.example/mcp" });
    const res = await post(t, { method: "tools/list", params: {} }, 4);
    expect(res.status).toBe(401);
  });
});

describe("AG-10 integration — revocation", () => {
  it("revoking the connection rejects older tokens; newer tokens still pass", async () => {
    const oldToken = await mint({ scope: "artifacts:read", iat: nowSec() - 600 });
    expect((await post(oldToken, { method: "tools/list", params: {} }, 5)).status).toBe(200);

    revokeConnection(CLIENT_ID, TENANT, nowSec());

    expect((await post(oldToken, { method: "tools/list", params: {} }, 6)).status).toBe(401);

    const newToken = await mint({ scope: "artifacts:read", iat: nowSec() + 5 });
    expect((await post(newToken, { method: "tools/list", params: {} }, 7)).status).toBe(200);
    clearRevocations();
  });
});

describe("AG-07 integration — ak_live_ regression", () => {
  it("an ak_live_ bearer keeps full tools, hits the PUBLIC API, no internal headers", async () => {
    const beforeInternal = internalStub.requestLog.length;
    const list = await post(VALID_KEY, { method: "tools/list", params: {} }, 8);
    const listBody = (await list.json()) as RpcEnvelope<{ tools: Array<{ name: string }> }>;
    // ak_live_ keys are full-access: the listing must match the registry
    // exactly, destroy tools included (count derived, not hardcoded — see the
    // scope-gating test above).
    const listedNames = listBody.result!.tools.map((tool) => tool.name).sort();
    expect(listedNames).toEqual(registeredToolNames());
    expect(listedNames).toContain("delete_artifact");

    const before = publicStub.requestLog.length;
    const call = await post(VALID_KEY, { method: "tools/call", params: { name: "whoami", arguments: {} } }, 9);
    expect(call.status).toBe(200);
    const pub = publicStub.requestLog
      .slice(before)
      .find((r) => r.method === "GET" && r.path === "/v1/whoami");
    expect(pub).toBeDefined();
    expect(pub!.headers["authorization"]).toBe(`Bearer ${VALID_KEY}`);
    expect(Object.keys(pub!.headers).some((k) => k.startsWith("x-artifacta-"))).toBe(false);
    expect(internalStub.requestLog.length).toBe(beforeInternal);
  });
});
