// Hosted Streamable HTTP transport (AG-01 / AG-02 / AG-03).
//
// Adds `POST /mcp` to the TypeScript MCP server using the SDK's
// StreamableHTTPServerTransport in stateless JSON-response mode. Stdio remains
// the default and is untouched (cli.ts only reaches here on --transport=http).
//
// Statelessness is load-bearing: there is no MCP-Session-Id and no per-request
// auth state to leak between clients. Each POST gets a fresh server + transport
// so concurrent clients can reuse JSON-RPC ids without colliding (the SDK's
// documented stateless pattern), and the request's bearer is scoped through an
// AsyncLocalStorage RequestContext (request-context.ts) that the tool/resource
// handlers read via getHttpClient().
//
// Endpoint contract (transport decision in hosted-mcp.md):
//   POST /mcp      → JSON-RPC, application/json
//   GET  /mcp      → 405 Method Not Allowed (no long-lived SSE in v1)
//   GET  /healthz  → 200 {"status":"ok"}
//   MCP-Protocol-Version: defaults to 2025-03-26 when absent; the SDK rejects
//                         unsupported versions with 400.

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server as HttpServer,
} from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "../config.js";
import { createArtifactaServer } from "../server.js";
import { logger } from "../log/logger.js";
import { ArtifactaHttpClient } from "./client.js";
import { resolvePrincipal } from "./auth.js";
import {
  runWithRequestContext,
  SCOPE_READ,
  SCOPE_WRITE,
  SCOPE_DESTROY,
  type Principal,
} from "./request-context.js";

// JSON-RPC bodies are tool calls and small payloads (inline store_artifact is
// the largest). 32 MiB is a generous process-protection ceiling; the REST API
// remains the real size authority and returns file_too_large past plan limits.
const MAX_BODY_BYTES = 32 * 1024 * 1024;

// Canonical resource identifier for this MCP server (RFC 9728 / the MCP OAuth
// spec's `resource` parameter). Carries the `/mcp` path. The protected-resource
// metadata document, by contrast, lives at the host root (see WELL_KNOWN_PATH);
// hosted-mcp.md line 67 pins the literal challenge URL to the root form.
const DEFAULT_RESOURCE_URI = "https://mcp.artifacta.io/mcp";

// RFC 9728 fixed location, served from the resource's origin (not under /mcp).
const WELL_KNOWN_PATH = "/.well-known/oauth-protected-resource";

// Supabase Auth is the OAuth 2.1 Authorization Server (HM-02). Trailing-slash-
// free, matching the discovery base the spec advertises.
const AUTHORIZATION_SERVER =
  "https://vliolvdztzcrtuolrgdi.supabase.co/auth/v1";

// The three MCP OAuth scopes (request-context.ts mirrors these for principals).
const SCOPES_SUPPORTED = [SCOPE_READ, SCOPE_WRITE, SCOPE_DESTROY] as const;

/** Absolute URL of the protected-resource metadata document for `resourceUri`.
 * Per hosted-mcp.md line 67 this is the resource's *origin* + the well-known
 * path — the `/mcp` path on `resourceUri` is intentionally dropped. The client
 * fetches exactly this URL (handed to it via `resource_metadata`), so it never
 * reconstructs the location itself. */
function metadataUrl(resourceUri: string): string {
  return new URL(resourceUri).origin + WELL_KNOWN_PATH;
}

export interface HttpServerOptions {
  /** TCP port to bind. 0 selects an ephemeral port (tests). */
  port: number;
  /** Base config — only `apiUrl` is used; the per-request bearer supplies the key. */
  config: Config;
  /** Exact-match allow-list for the Origin header. Empty disables browser clients. */
  allowedOrigins: readonly string[];
  /** Canonical resource identifier (RFC 9728 `resource`) — what unauthenticated
   * OAuth challenges advertise and what the protected-resource metadata reports.
   * Defaults to {@link DEFAULT_RESOURCE_URI}; cli.ts threads `MCP_RESOURCE_URI`. */
  resourceUri?: string;
}

export interface StartedHttpServer {
  server: HttpServer;
  port: number;
  close(): Promise<void>;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/** Force the Accept header to `value` on both the parsed headers and the
 * `rawHeaders` array (the latter is what @hono/node-server reads when the SDK
 * rebuilds the request as a Web Request). */
function setAcceptHeader(req: IncomingMessage, value: string): void {
  req.headers.accept = value;
  const raw = req.rawHeaders;
  let found = false;
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i]?.toLowerCase() === "accept") {
      raw[i + 1] = value;
      found = true;
    }
  }
  if (!found) raw.push("Accept", value);
}

/** RFC 9728 §5.1 challenge: point an OAuth-capable client at the protected-
 * resource metadata so it can discover the authorization server. `resource_uri`
 * is the canonical resource; the metadata URL is its origin-rooted well-known. */
function bearerChallenge(resourceUri: string): string {
  return `Bearer resource_metadata="${metadataUrl(resourceUri)}"`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Length", Buffer.byteLength(payload));
  res.end(payload);
}

/** Read the request body with a hard ceiling. Rejects with `oversize` past the
 * cap so the caller can answer 413 without buffering an unbounded stream. */
function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("oversize"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handleMcpPost(
  req: IncomingMessage,
  res: ServerResponse,
  opts: HttpServerOptions
): Promise<void> {
  // AG-03: hosted MCP responses are never cacheable.
  res.setHeader("Cache-Control", "no-store");

  // AG-03: validate Origin when present; absent Origin (headless/CI) is allowed.
  const origin = headerValue(req.headers.origin);
  if (origin !== undefined && !opts.allowedOrigins.includes(origin)) {
    logger.warning("rejected disallowed origin", { origin });
    sendJson(res, 403, {
      error: { code: "forbidden", message: "Origin not allowed", status: 403 },
    });
    return;
  }

  // AG-02: resolve the `ak_live_` bearer. The token itself is never logged.
  const principal = resolvePrincipal(headerValue(req.headers.authorization));
  if (!principal) {
    // AG-05: OAuth-capable clients arriving without (or with a non-`ak_live_`)
    // bearer get an RFC 9728 challenge pointing at the protected-resource
    // metadata; the JSON error body is unchanged for the existing headless path.
    res.setHeader("WWW-Authenticate", bearerChallenge(opts.resourceUri ?? DEFAULT_RESOURCE_URI));
    sendJson(res, 401, {
      error: {
        code: "unauthorized",
        message: "Missing or malformed bearer token",
        status: 401,
      },
    });
    return;
  }

  let raw: Buffer;
  try {
    raw = await readBody(req, MAX_BODY_BYTES);
  } catch (err) {
    if (err instanceof Error && err.message === "oversize") {
      sendJson(res, 413, {
        error: {
          code: "file_too_large",
          message: "Request body exceeds limit",
          status: 413,
        },
      });
      return;
    }
    sendJson(res, 400, {
      error: { code: "invalid_request", message: "Failed to read request body", status: 400 },
    });
    return;
  }

  // The body is fully drained above, so the SDK cannot re-read the stream — it
  // must receive the pre-parsed body. Mirror the SDK's own -32700 on bad JSON.
  let parsedBody: unknown;
  try {
    parsedBody = raw.length === 0 ? undefined : JSON.parse(raw.toString("utf8"));
  } catch {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error: Invalid JSON" },
      })
    );
    return;
  }

  // The SDK requires the client to Accept both application/json and
  // text/event-stream even in JSON-response mode. Normalize so headless callers
  // (curl, CI, A2A) work; the response is application/json regardless. The SDK's
  // Node wrapper rebuilds the Web Request from `rawHeaders`, so both must be set.
  setAcceptHeader(req, "application/json, text/event-stream");

  await dispatch(req, res, parsedBody, principal, opts.config);
}

/** Mint a request-scoped server/client/transport, then dispatch under the
 * principal's AsyncLocalStorage context. */
async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  parsedBody: unknown,
  principal: Principal,
  baseConfig: Config
): Promise<void> {
  // Per-request HTTP client carries this principal's key; the Authorization
  // header it sends to api.artifacta.io is exactly `Bearer <ak_live_...>`, with
  // no internal service headers (AG-02 / the spec's no-passthrough exemption).
  const requestConfig: Config = {
    apiKey: principal.token,
    apiUrl: baseConfig.apiUrl,
  };
  const httpClient = new ArtifactaHttpClient(requestConfig);

  const mcpServer = createArtifactaServer();
  mcpServer.setConfig(requestConfig);
  // Stateless JSON mode never replays the client's `initialize`, so a fresh
  // per-request server always reports no client capabilities — confirmation
  // gating and the requiresConfirmation _meta are therefore inert over HTTP.
  // A full-scope API key restores full tool visibility (API keys are
  // full-access, matching stdio with --allow-destructive). OAuth principals
  // (AG-07) will instead gate destructive tools on artifacts:destroy.
  //
  // OPEN_QUESTION (HM-04 security sign-off): tool parity exposes the path-based
  // store_artifact over HTTP, which reads the *container's* filesystem (CWD-
  // confined, non-root, no on-disk secrets — so near-zero exposure today). This
  // becomes a cross-tenant read risk the moment a deployment mounts a volume,
  // sets ARTIFACTA_MCP_ALLOW_PATH, or writes sensitive data to disk. Revisit
  // before public OAuth launch (hide path tools over HTTP, or hard-confine).
  mcpServer.setSafetyFlags({
    allowDestructive: principal.scopes.includes(SCOPE_DESTROY),
    writeConfirmRequired: false,
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on("close", () => {
    void transport.close();
    void mcpServer.close();
  });

  try {
    await mcpServer.connect(transport);
    await runWithRequestContext({ principal, httpClient }, () =>
      transport.handleRequest(req, res, parsedBody)
    );
  } catch (err) {
    logger.error("hosted MCP dispatch failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    if (!res.headersSent) {
      sendJson(res, 500, {
        error: { code: "server_error", message: "Internal error", status: 500 },
      });
    }
  }
}

function route(opts: HttpServerOptions) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const method = req.method ?? "GET";
    const path = (req.url ?? "/").split("?")[0];

    if (path === "/healthz" && method === "GET") {
      sendJson(res, 200, { status: "ok" });
      return;
    }

    // AG-05: public OAuth Protected Resource Metadata (RFC 9728). No auth — a
    // client fetches this *because* it has no token yet. Served from the host
    // root regardless of `resourceUri`'s `/mcp` path.
    if (path === WELL_KNOWN_PATH && method === "GET") {
      const resourceUri = opts.resourceUri ?? DEFAULT_RESOURCE_URI;
      res.setHeader("Cache-Control", "no-store");
      sendJson(res, 200, {
        resource: resourceUri,
        authorization_servers: [AUTHORIZATION_SERVER],
        scopes_supported: SCOPES_SUPPORTED,
        bearer_methods_supported: ["header"],
      });
      return;
    }

    if (path === "/mcp") {
      if (method === "POST") {
        void handleMcpPost(req, res, opts);
        return;
      }
      // GET (and any other verb) on /mcp: no SSE stream in v1.
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Allow", "POST");
      sendJson(res, 405, {
        error: { code: "method_not_allowed", message: "Method Not Allowed", status: 405 },
      });
      return;
    }

    sendJson(res, 404, {
      error: { code: "not_found", message: "Not Found", status: 404 },
    });
  };
}

/** Start the hosted HTTP server. Resolves once it is listening. */
export function startHttpServer(opts: HttpServerOptions): Promise<StartedHttpServer> {
  const server = createServer(route(opts));

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, () => {
      server.removeListener("error", reject);
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : opts.port;
      logger.notice("hosted MCP HTTP server listening", {
        port,
        api_url: opts.config.apiUrl,
        allowed_origins: opts.allowedOrigins.length,
      });
      resolve({
        server,
        port,
        close: () =>
          new Promise<void>((res, rej) =>
            server.close((err) => (err ? rej(err) : res()))
          ),
      });
    });
  });
}
