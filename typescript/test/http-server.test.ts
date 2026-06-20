// AG-01 / AG-02 / AG-03 — hosted Streamable HTTP transport unit tests.
//
// Boots the real HTTP server on an ephemeral port and drives it over fetch.
// The whoami case points the per-request client at a local stub API to prove
// the `ak_live_` bearer is forwarded verbatim (and that the request-scoped
// AsyncLocalStorage context reaches the tool handler through getHttpClient()).

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import {
  startHttpServer,
  type StartedHttpServer,
} from "../src/http/transport.js";
import { registerAllTools, registerAllResources } from "../src/tools/index.js";
import { startStubServer, type StartedStub } from "./integration/stub-server.js";
import {
  setLogWriter,
  resetLogWriter,
  setLogLevel,
  resetLogger,
} from "../src/log/logger.js";

// ak_live_ + 32 alphanumerics (matches config.KEY_REGEX).
const VALID_KEY = "ak_live_0123456789abcdefghijklmnopqrstuv";
const ALLOWED_ORIGIN = "https://app.artifacta.io";

let started: StartedHttpServer;
let stub: StartedStub;
let base: string;

function mcpBody(method: string, params: unknown, id = 1): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

const INITIALIZE_PARAMS = {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "test-client", version: "0.0.0" },
};

beforeAll(async () => {
  setLogWriter(() => {}); // silence expected startup/origin log noise
  registerAllTools();
  registerAllResources();
  stub = await startStubServer({
    "GET /v1/whoami": () => ({
      status: 200,
      body: JSON.stringify({
        tenant_name: "test-tenant",
        plan: "free",
        api_key_last_4: "stuv",
        usage_requests_month: 0,
        plan_requests_limit_month: 1000,
        usage_storage_bytes: 0,
        plan_storage_limit_bytes: 1000,
      }),
    }),
  });
  started = await startHttpServer({
    port: 0,
    config: { apiKey: undefined, apiUrl: stub.url },
    allowedOrigins: [ALLOWED_ORIGIN],
  });
  base = `http://127.0.0.1:${started.port}`;
});

afterAll(async () => {
  await started.close();
  await stub.close();
  resetLogWriter();
});

describe("GET /healthz", () => {
  it("returns 200 with {status:'ok'}", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("GET /mcp", () => {
  it("returns 405 Method Not Allowed with Allow: POST", async () => {
    const res = await fetch(`${base}/mcp`);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("GET /.well-known/oauth-protected-resource (AG-05)", () => {
  const WELL_KNOWN = "/.well-known/oauth-protected-resource";

  it("returns 200 with the RFC 9728 metadata document", async () => {
    const res = await fetch(`${base}${WELL_KNOWN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      resource: string;
      authorization_servers: string[];
      scopes_supported: string[];
      bearer_methods_supported: string[];
    };
    // Default resourceUri keeps the /mcp path on `resource`.
    expect(body.resource).toBe("https://mcp.artifacta.io/mcp");
    expect(body.authorization_servers).toEqual([
      "https://vliolvdztzcrtuolrgdi.supabase.co/auth/v1",
    ]);
    expect(body.scopes_supported).toEqual([
      "artifacts:read",
      "artifacts:write",
      "artifacts:destroy",
    ]);
    expect(body.bearer_methods_supported).toEqual(["header"]);
  });

  it("does not require authentication", async () => {
    // No Authorization header — the client fetches this precisely because it has
    // no token yet.
    const res = await fetch(`${base}${WELL_KNOWN}`, { method: "GET" });
    expect(res.status).toBe(200);
  });

  // The metadata document lives at the resource's *origin* + well-known path,
  // even though `resource` itself carries a path. Prove that split holds for a
  // custom MCP_RESOURCE_URI and that `resource` is reported back verbatim.
  it("reports the exact resourceUri and roots metadata at its origin", async () => {
    const custom = await startHttpServer({
      port: 0,
      config: { apiKey: undefined, apiUrl: stub.url },
      allowedOrigins: [ALLOWED_ORIGIN],
      resourceUri: "https://mcp.example.test/mcp",
    });
    try {
      const customBase = `http://127.0.0.1:${custom.port}`;
      const res = await fetch(`${customBase}${WELL_KNOWN}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { resource: string };
      expect(body.resource).toBe("https://mcp.example.test/mcp");

      // And the challenge for that server uses the origin-rooted metadata URL.
      const unauth = await fetch(`${customBase}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: mcpBody("initialize", INITIALIZE_PARAMS),
      });
      expect(unauth.status).toBe(401);
      expect(unauth.headers.get("www-authenticate")).toBe(
        'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource"'
      );
    } finally {
      await custom.close();
    }
  });
});

describe("POST /mcp auth (AG-02)", () => {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  it("returns 401 when the Authorization header is missing", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers,
      body: mcpBody("initialize", INITIALIZE_PARAMS),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  // AG-05: the same 401 must also hand an OAuth-capable client the RFC 9728
  // challenge so it can discover the authorization server. The default
  // resourceUri (mcp.artifacta.io/mcp) resolves the metadata to the host root.
  it("includes the WWW-Authenticate challenge pointing at the metadata", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers,
      body: mcpBody("initialize", INITIALIZE_PARAMS),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://mcp.artifacta.io/.well-known/oauth-protected-resource"'
    );
  });

  it("includes the challenge on a malformed (non ak_live_) bearer too", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...headers, Authorization: "Bearer not-an-artifacta-key" },
      body: mcpBody("initialize", INITIALIZE_PARAMS),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://mcp.artifacta.io/.well-known/oauth-protected-resource"'
    );
  });

  it("returns 401 when the bearer is not a well-formed ak_live_ key", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...headers, Authorization: "Bearer not-an-artifacta-key" },
      body: mcpBody("initialize", INITIALIZE_PARAMS),
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 for a bearer with a wrong-length key", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...headers, Authorization: "Bearer ak_live_tooshort" },
      body: mcpBody("initialize", INITIALIZE_PARAMS),
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /mcp origin validation (AG-03)", () => {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${VALID_KEY}`,
  };

  it("returns 403 when Origin is not in the allow-list", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...headers, Origin: "https://evil.example.com" },
      body: mcpBody("initialize", INITIALIZE_PARAMS),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("forbidden");
  });

  it("allows an Origin that is in the allow-list", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...headers, Origin: ALLOWED_ORIGIN },
      body: mcpBody("initialize", INITIALIZE_PARAMS),
    });
    expect(res.status).toBe(200);
  });
});

describe("POST /mcp protocol version", () => {
  it("rejects an unsupported MCP-Protocol-Version with 400", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${VALID_KEY}`,
        "MCP-Protocol-Version": "1999-01-01",
      },
      body: mcpBody("tools/list", {}, 7),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /mcp initialize (AG-01)", () => {
  it("returns an InitializeResult as application/json", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${VALID_KEY}`,
      },
      body: mcpBody("initialize", INITIALIZE_PARAMS),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("mcp-session-id")).toBeNull();
    // no-store (AG-03) must survive on the transport-written success response.
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as {
      result: { serverInfo: { name: string }; protocolVersion: string };
    };
    expect(body.result.serverInfo.name).toBe("artifacta");
    expect(body.result.protocolVersion).toBeTruthy();
  });
});

describe("POST /mcp tool call forwards the bearer (AG-02)", () => {
  it("calls the REST API with Authorization: Bearer <key> and no internal headers", async () => {
    const before = stub.requestLog.length;
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${VALID_KEY}`,
      },
      body: mcpBody("tools/call", { name: "whoami", arguments: {} }, 3),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { isError?: boolean } };
    expect(body.result.isError).toBeFalsy();

    const whoamiCall = stub.requestLog
      .slice(before)
      .find((r) => r.method === "GET" && r.path === "/v1/whoami");
    expect(whoamiCall).toBeDefined();
    expect(whoamiCall!.headers["authorization"]).toBe(`Bearer ${VALID_KEY}`);
    // No internal service headers leak onto the ak_live_ path.
    const internalHeader = Object.keys(whoamiCall!.headers).find((k) =>
      k.startsWith("x-artifacta-")
    );
    expect(internalHeader).toBeUndefined();
  });
});

describe("AG-03 no-secret logging", () => {
  afterEach(() => {
    resetLogger();
  });

  it("never writes the API key or bearer token to logs", async () => {
    const logs: string[] = [];
    setLogLevel("debug");
    setLogWriter((line) => logs.push(line));

    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${VALID_KEY}`,
      },
      body: mcpBody("tools/call", { name: "whoami", arguments: {} }, 9),
    });
    expect(res.status).toBe(200);
    await res.json();

    resetLogWriter();
    const joined = logs.join("\n");
    expect(joined).not.toContain(VALID_KEY);
    expect(joined).not.toContain("0123456789abcdefghijklmnopqrstuv");
  });
});
