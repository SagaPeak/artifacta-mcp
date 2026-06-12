// Local HTTP stub server for the non-retry / synthetic-5xx subsuite
// (AF_MCP-7.2.09–11) and any test that needs deterministic responses
// without depending on staging.
//
// Lifecycle (per-test):
//   const stub = await startStubServer({ "POST /v1/artifacts/upload-url": () => ({ status: 502, body: '...' }) });
//   try { ... } finally { await stub.close(); }
// Uses an ephemeral port (`server.listen(0)`) so files don't fight over
// fixed ports in CI; one stub per test keeps lifecycle clear.

import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export interface StubResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string;
}

export type StubHandler = (
  req: IncomingMessage,
  body: string
) => StubResponse | Promise<StubResponse>;

export interface StubRoutes {
  // Keys: "METHOD /path" (preferred) or "/path" (any method).
  [route: string]: StubHandler;
}

export interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

export interface StartedStub {
  url: string;
  origin: string;
  port: number;
  /** Every request received, in order. */
  requestLog: CapturedRequest[];
  close(): Promise<void>;
}

export async function startStubServer(routes: StubRoutes): Promise<StartedStub> {
  const requestLog: CapturedRequest[] = [];

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        headers[k.toLowerCase()] = Array.isArray(v) ? v.join(",") : v;
      }
      requestLog.push({
        method: req.method ?? "GET",
        path: req.url ?? "/",
        headers,
        body,
      });
      const handler = matchRoute(routes, req.method ?? "GET", req.url ?? "/");
      if (!handler) {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            error: {
              code: "not_found",
              message: `no stub route for ${req.method} ${req.url}`,
              status: 404,
            },
          })
        );
        return;
      }
      Promise.resolve(handler(req, body))
        .then((out) => {
          res.statusCode = out.status;
          if (out.headers) {
            for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
          }
          if (!res.getHeader("content-type")) {
            res.setHeader("content-type", "application/json");
          }
          res.end(out.body ?? "");
        })
        .catch((err: unknown) => {
          res.statusCode = 500;
          res.setHeader("content-type", "text/plain");
          res.end(
            `stub handler threw: ${err instanceof Error ? err.message : String(err)}`
          );
        });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    url,
    origin: url,
    port: addr.port,
    requestLog,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    },
  };
}

function matchRoute(
  routes: StubRoutes,
  method: string,
  url: string
): StubHandler | undefined {
  const u = new URL(url, "http://127.0.0.1");
  const candidates = [`${method.toUpperCase()} ${u.pathname}`, u.pathname];
  for (const c of candidates) {
    const handler = routes[c];
    if (handler) return handler;
  }
  return undefined;
}
