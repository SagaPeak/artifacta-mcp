// AG-12 (Phase 0 slice) — hosted Streamable HTTP integration over `POST /mcp`
// with an `ak_live_` bearer.
//
// This is the integration-suite counterpart to the unit `test/http-server.test.ts`:
// it boots the real HTTP transport (src/http/transport.ts) on an ephemeral port,
// points the per-request client at a local stub API, and drives the full
// JSON-RPC happy path a headless/A2A caller uses — `initialize`, `tools/list`,
// and `tools/call` for `whoami` and `list_artifacts` — exactly as the live
// `mcp.artifacta.io` canary does. No staging is required (the stub stands in for
// the REST API), so this file runs on every `npm run test:integration`.
//
// Scope: Phase 0 `ak_live_` only. OAuth audience/scope/revocation coverage and
// the internal-secret API-path tests are the remaining AG-12 ACs and land with
// AG-06 / AG-07 / AG-10.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  startHttpServer,
  type StartedHttpServer,
} from "../../src/http/transport.js";
import { registerAllTools, registerAllResources } from "../../src/tools/index.js";
import { clearRegistry } from "../../src/safety/registry.js";
import { clearResourceRegistry } from "../../src/resources/registry.js";
import { startStubServer, type StartedStub } from "./stub-server.js";
import { setLogWriter, resetLogWriter } from "../../src/log/logger.js";

// ak_live_ + 32 alphanumerics (matches config.KEY_REGEX). Never a real key.
const VALID_KEY = "ak_live_0123456789abcdefghijklmnopqrstuv";

// The dual Accept value is what a compliant MCP client sends; the transport
// normalizes it, but exercising it here keeps the integration honest.
const ACCEPT = "application/json, text/event-stream";

let started: StartedHttpServer;
let stub: StartedStub;
let base: string;

function rpc(method: string, params: unknown, id = 1): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

function post(body: string): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: ACCEPT,
      Authorization: `Bearer ${VALID_KEY}`,
    },
    body,
  });
}

const INITIALIZE_PARAMS = {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "ag-12-integration", version: "0.0.0" },
};

beforeAll(async () => {
  setLogWriter(() => {}); // silence expected startup/origin log noise
  clearRegistry();
  clearResourceRegistry();
  registerAllTools();
  registerAllResources();

  stub = await startStubServer({
    "GET /v1/whoami": () => ({
      status: 200,
      body: JSON.stringify({
        tenant_name: "test-tenant",
        plan: "free",
        api_key_last_4: "stuv",
        usage_requests_month: 3,
        plan_requests_limit_month: 1000,
        usage_storage_bytes: 0,
        plan_storage_limit_bytes: 1_000_000,
      }),
    }),
    "GET /v1/artifacts": () => ({
      status: 200,
      body: JSON.stringify({
        artifacts: [
          {
            artifact_id: "art_0123456789abcdef",
            filename: "report.txt",
            content_type: "text/plain",
            size_bytes: 12,
            created_at: "2026-06-20T00:00:00Z",
          },
        ],
        next_cursor: null,
        has_more: false,
      }),
    }),
  });

  started = await startHttpServer({
    port: 0,
    config: { apiKey: undefined, apiUrl: stub.url },
    allowedOrigins: [],
  });
  base = `http://127.0.0.1:${started.port}`;
});

afterAll(async () => {
  await started.close();
  await stub.close();
  clearRegistry();
  clearResourceRegistry();
  resetLogWriter();
});

interface RpcResult<T> {
  jsonrpc: string;
  id: number;
  result: T;
}

interface ToolCallResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

describe("AG-12 — hosted HTTP POST /mcp with ak_live_ bearer", () => {
  it("initialize returns the artifacta InitializeResult as application/json", async () => {
    const res = await post(rpc("initialize", INITIALIZE_PARAMS));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("mcp-session-id")).toBeNull();
    const body = (await res.json()) as RpcResult<{
      serverInfo: { name: string };
      protocolVersion: string;
    }>;
    expect(body.result.serverInfo.name).toBe("artifacta");
    expect(body.result.protocolVersion).toBeTruthy();
  });

  it("tools/list exposes the read tools by name (whoami, list_artifacts)", async () => {
    const res = await post(rpc("tools/list", {}, 2));
    expect(res.status).toBe(200);
    const body = (await res.json()) as RpcResult<{ tools: Array<{ name: string }> }>;
    const names = body.result.tools.map((t) => t.name);
    expect(names).toContain("whoami");
    expect(names).toContain("list_artifacts");
  });

  it("tools/call whoami succeeds and forwards the bearer with no internal headers", async () => {
    const before = stub.requestLog.length;
    const res = await post(rpc("tools/call", { name: "whoami", arguments: {} }, 3));
    expect(res.status).toBe(200);
    const body = (await res.json()) as RpcResult<ToolCallResult>;
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text) as Record<string, unknown>;
    expect(payload.tenant_name).toBe("test-tenant");
    expect(payload.plan).toBe("free");

    const call = stub.requestLog
      .slice(before)
      .find((r) => r.method === "GET" && r.path === "/v1/whoami");
    expect(call).toBeDefined();
    expect(call!.headers["authorization"]).toBe(`Bearer ${VALID_KEY}`);
    const internalHeader = Object.keys(call!.headers).find((k) =>
      k.startsWith("x-artifacta-")
    );
    expect(internalHeader).toBeUndefined();
  });

  it("tools/call list_artifacts returns the standard list shape", async () => {
    const res = await post(rpc("tools/call", { name: "list_artifacts", arguments: {} }, 4));
    expect(res.status).toBe(200);
    const body = (await res.json()) as RpcResult<ToolCallResult>;
    expect(body.result.isError).toBeFalsy();
    const payload = JSON.parse(body.result.content[0].text) as {
      artifacts: unknown[];
      has_more: boolean;
    };
    expect(Array.isArray(payload.artifacts)).toBe(true);
    expect(payload.artifacts).toHaveLength(1);
    expect(payload.has_more).toBe(false);
  });
});
