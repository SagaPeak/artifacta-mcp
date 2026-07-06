#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { server, VERSION } from "./server.js";
import { registerShutdownHandlers } from "./lifecycle.js";
import { loadConfig } from "./config.js";
import { parseSafetyFlags } from "./safety/flags.js";
import { buildAllowList, logAllowList } from "./path/confinement.js";
import { setAllowRoots } from "./path/allowlist.js";
import { isLogLevel, setLogLevel, logger } from "./log/logger.js";
import { setTelemetryMode } from "./telemetry/emitter.js";
import { ArtifactaHttpClient } from "./http/client.js";
import { setHttpClient } from "./http/instance.js";
import { startHttpServer, DEFAULT_RESOURCE_URI } from "./http/transport.js";
import { resolveAuthorizationServer } from "./http/authorization-server.js";
import type { OAuthVerifier } from "./http/oauth.js";
import { resolveOAuthConfig } from "./http/oauth-config.js";
import { registerAllTools, registerAllResources } from "./tools/index.js";

const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  process.stdout.write(VERSION + "\n");
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(
    [
      `artifacta-mcp v${VERSION}`,
      "",
      "Artifacta MCP server — artifact store for AI agents.",
      "",
      "Usage:",
      "  artifacta-mcp [options]",
      "",
      "Options:",
      "  --version, -v              Print version and exit",
      "  --help, -h                 Show this help",
      "  --transport=stdio|http     Transport (default: stdio). http serves Streamable HTTP at POST /mcp",
      "  --port=<n>                 HTTP port when --transport=http (default: $PORT or 8080)",
      "  --api-key=<key>            Artifacta API key (overrides env and config file)",
      "  --api-url=<url>            Artifacta API base URL (default: https://api.artifacta.io)",
      "  --profile=<name>           Config file profile to use (default: 'default')",
      "  --allow-destructive        Expose destructive tools to non-compliant clients (per-launch only)",
      "  --allow-path=<abs-path>    Append to path allow-list (colon-separated; default: CWD)",
      "  --log-level=<level>        Initial log level: debug, info, notice (default), warning, error, critical, alert, emergency",
      "  --telemetry=on|off         Anonymous opt-in telemetry (default: off; payload contains no arg values or response bodies)",
      "",
      "Config file: ~/.artifacta/mcp.toml",
      "Env vars:    ARTIFACTA_API_KEY, ARTIFACTA_API_URL, ARTIFACTA_PROFILE",
      "             ARTIFACTA_MCP_REQUIRE_WRITE_CONFIRM=1  Require confirmation for write tools",
      "             ARTIFACTA_MCP_ALLOW_PATH=<paths>       Colon-separated extra allow-list roots",
      "             PORT=<n>                               HTTP port (--transport=http; Railway sets this)",
      "             MCP_ALLOWED_ORIGINS=<a,b>              Comma-separated allowed Origin headers (http)",
      "             MCP_RESOURCE_URI=<url>                 Canonical OAuth resource URI (http; default mcp.artifacta.io/mcp)",
      "             SUPABASE_JWKS_URL=<url>                Supabase JWKS endpoint; set to enable OAuth JWT validation (http)",
      "             SUPABASE_AUTH_BASE=<url>               OAuth AS base for PRM authorization_servers (http; default vanity URL)",
      "             MCP_OAUTH_CLIENT_ID=<id>               Registered MCP OAuth client_id; OAuth tokens must match it (http; required with OAuth, including DCR mode — fixed-client fallback + instant rollback)",
      "             MCP_OAUTH_DCR_ENABLED=1                Accept dynamically-registered OAuth clients (relax client_id binding to client_id-present + MCP aud; http)",
      "             ARTIFACTA_INTERNAL_API_URL=<url>       Private internal API base for OAuth-backed calls (http; required with OAuth)",
      "             MCP_INTERNAL_SECRET=<secret>           Shared secret for the internal API path (http; required with OAuth)",
      "",
    ].join("\n")
  );
  process.exit(0);
}

// Initial log level — must precede any logging call below.
const logLevelArg = args.find((a) => a.startsWith("--log-level="));
if (logLevelArg) {
  const value = logLevelArg.slice("--log-level=".length);
  if (isLogLevel(value)) {
    setLogLevel(value);
  } else {
    process.stderr.write(
      `[artifacta-mcp] error: invalid --log-level=${value}; expected one of debug, info, notice, warning, error, critical, alert, emergency\n`
    );
    process.exit(2);
  }
}

// Telemetry mode (default: off). Plan §9.4: never includes arg values or response bodies.
if (args.includes("--telemetry=on")) {
  setTelemetryMode("on");
  logger.info("telemetry enabled (anonymous, opt-in)");
} else if (args.includes("--telemetry=off")) {
  setTelemetryMode("off");
}

// Transport + port selection. Supports `--flag=value` and `--flag value`.
function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith(prefix)) return a.slice(prefix.length);
    if (a === `--${name}` && i + 1 < args.length) return args[i + 1];
  }
  return undefined;
}

const transportMode = (argValue("transport") ?? "stdio").toLowerCase();
if (transportMode !== "stdio" && transportMode !== "http") {
  process.stderr.write(
    `[artifacta-mcp] error: invalid --transport=${transportMode}; expected 'stdio' or 'http'\n`
  );
  process.exit(2);
}

// Port: --port flag, else $PORT (Railway injects this), else 8080.
let httpPort = 8080;
const portRaw = argValue("port") ?? process.env.PORT;
if (portRaw !== undefined && portRaw !== "") {
  const parsed = Number(portRaw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    process.stderr.write(
      `[artifacta-mcp] error: invalid port '${portRaw}'; expected an integer 1-65535\n`
    );
    process.exit(2);
  }
  httpPort = parsed;
}

const config = loadConfig(args);
server.setConfig(config);

const safetyFlags = parseSafetyFlags(args);
server.setSafetyFlags(safetyFlags);

// Build path allow-list at startup (exits 2 on relative entries)
const allowRoots = buildAllowList(args);
logAllowList(allowRoots);
setAllowRoots(allowRoots);

// HTTP client + tool/resource registration must happen before transport
// connect so the first tools/list and resources/list responses include them.
setHttpClient(new ArtifactaHttpClient(config));
registerAllTools();
registerAllResources();

process.on("uncaughtException", (err) => {
  process.stderr.write(
    `[artifacta-mcp] uncaughtException: ${err.stack ?? err.message}\n`
  );
  server.sendLoggingMessage({
    level: "error",
    data: `uncaughtException: ${err.message}`,
  }).catch(() => {
    // transport may not be connected yet — already logged to stderr
  });
});

process.on("unhandledRejection", (reason) => {
  const msg =
    reason instanceof Error
      ? (reason.stack ?? reason.message)
      : String(reason);
  process.stderr.write(`[artifacta-mcp] unhandledRejection: ${msg}\n`);
  server.sendLoggingMessage({
    level: "error",
    data: `unhandledRejection: ${msg}`,
  }).catch(() => {
    // transport may not be connected yet — already logged to stderr
  });
});

if (transportMode === "http") {
  // Hosted Streamable HTTP. Per-request `ak_live_` bearer auth (no server key
  // required); stdio remains the default and is unaffected.
  const allowedOrigins = (process.env.MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // AG-05: canonical resource identifier for OAuth metadata / challenges. The
  // transport defaults this when unset, so omit the field rather than passing "".
  const resourceUri = process.env.MCP_RESOURCE_URI?.trim() || undefined;
  // The OAuth audience must equal the resource id (default included).
  const resourceUriValue = resourceUri ?? DEFAULT_RESOURCE_URI;

  // AG-07: enable OAuth JWT validation when a JWKS URL is configured. The
  // `ak_live_` headless path stays available regardless; OAuth is additive.
  // OAuth-backed calls go through the PRIVATE internal API (AG-06) — the public
  // `ARTIFACTA_API_URL` keeps serving `ak_live_` traffic (dual-URL by design).
  //
  // resolveOAuthConfig fails the deploy fast (rather than 500 per request, or —
  // worse — leaking the internal secret) when OAuth is enabled but: the internal
  // path is missing, the client binding (MCP_OAUTH_CLIENT_ID) is missing, or the
  // internal origin equals the public origin.
  const oauthRes = resolveOAuthConfig({
    jwksUrl: process.env.SUPABASE_JWKS_URL,
    internalApiUrl: process.env.ARTIFACTA_INTERNAL_API_URL,
    internalSecret: process.env.MCP_INTERNAL_SECRET,
    clientId: process.env.MCP_OAUTH_CLIENT_ID,
    publicApiUrl: config.apiUrl,
    audience: resourceUriValue,
    // AG-DCR-02: when set, accept dynamically-registered OAuth clients (relax the
    // exact MCP_OAUTH_CLIENT_ID binding to client_id-present + MCP aud). Default off
    // keeps the strict single-id binding; this is the instant-rollback switch (§5).
    dcrEnabled: process.env.MCP_OAUTH_DCR_ENABLED === "1",
  });

  let oauthVerifier: OAuthVerifier | undefined;
  let internalApiUrl: string | undefined;
  let internalSecret: string | undefined;
  let authorizationServer: string | undefined;
  if (oauthRes.enabled) {
    if ("errors" in oauthRes) {
      process.stderr.write(
        "[artifacta-mcp] fatal: SUPABASE_JWKS_URL is set (OAuth enabled) but the OAuth configuration is incomplete or unsafe:\n" +
          oauthRes.errors.map((e) => `  - ${e}`).join("\n") +
          "\nSet the above, or unset SUPABASE_JWKS_URL to run ak_live_-only.\n"
      );
      process.exit(2);
    }
    oauthVerifier = oauthRes.config.verifier;
    internalApiUrl = oauthRes.config.internalApiUrl;
    internalSecret = oauthRes.config.internalSecret;
    authorizationServer = resolveAuthorizationServer(
      process.env.SUPABASE_AUTH_BASE
    );
  }

  startHttpServer({
    port: httpPort,
    config,
    allowedOrigins,
    resourceUri,
    authorizationServer,
    oauthVerifier,
    internalApiUrl,
    internalSecret,
  })
    .then((started) => {
      const shutdown = (): void => {
        void started.close().finally(() => process.exit(0));
      };
      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[artifacta-mcp] fatal: failed to start HTTP server: ${msg}\n`);
      process.exit(1);
    });
} else {

registerShutdownHandlers(server);

const transport = new StdioServerTransport();

// Set onerror BEFORE connect so the SDK preserves it in its wrapper.
// Handles parse errors (malformed JSON, binary garbage) by:
//   1. Logging to stderr
//   2. Sending a -32600 Invalid Request JSON-RPC error response (id: null)
transport.onerror = (err) => {
  process.stderr.write(`[artifacta-mcp] transport error: ${err.message}\n`);
  server.sendLoggingMessage({
    level: "error",
    data: `transport error: ${err.message}`,
  }).catch(() => {});
  // JSON-RPC 2.0 §5: id MUST be null when the request id cannot be determined.
  // Distinguish parse errors (-32700) from schema-invalid requests (-32600):
  // SyntaxError = JSON.parse failed (bad JSON, binary garbage) → ParseError
  // Anything else = valid JSON but invalid JSON-RPC shape → InvalidRequest
  const isParseError = err instanceof SyntaxError;
  const errorResponse = {
    jsonrpc: "2.0" as const,
    id: null,
    error: isParseError
      ? { code: ErrorCode.ParseError, message: "Parse error" }
      : { code: ErrorCode.InvalidRequest, message: "Invalid Request" },
  } as unknown as JSONRPCMessage;
  transport.send(errorResponse).catch(() => {});
};

server.connect(transport).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[artifacta-mcp] fatal: ${msg}\n`);
  process.exit(1);
});

// Test-only: inject an uncaughtException after init completes.
// Activated by _ARTIFACTA_TEST_INJECT_EXCEPTION=1 env var.
if (process.env._ARTIFACTA_TEST_INJECT_EXCEPTION === "1") {
  setTimeout(() => {
    throw new Error("test-injected-exception");
  }, 300);
}

}
