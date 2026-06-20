import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListPromptsRequestSchema,
  ReadResourceRequestSchema,
  CallToolRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Config } from "./config.js";
import type { SafetyFlags } from "./safety/flags.js";
import { getFilteredTools, getToolRegistration, isCallPermitted } from "./safety/registry.js";
import { emitDestructiveAudit } from "./safety/audit.js";
import {
  listResources,
  getResourceReader,
  listResourceTemplates,
  matchResourceTemplate,
} from "./resources/registry.js";
import { fetchRecentArtifactResources } from "./resources/list-recent.js";
import { logger } from "./log/logger.js";
import { registerSetLevelHandler } from "./log/setlevel.js";
import { emitTelemetry } from "./telemetry/emitter.js";
import { setOutageNotifier } from "./escalation/tracker.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(
  readFileSync(join(__dirname, "../package.json"), "utf-8")
) as { version: string };

export const VERSION: string = pkg.version;

class ArtifactaServer extends Server {
  private _config: Config | undefined;
  private _safetyFlags: SafetyFlags = {
    allowDestructive: false,
    writeConfirmRequired: false,
  };

  setConfig(config: Config): void {
    this._config = config;
  }

  getConfig(): Config | undefined {
    return this._config;
  }

  setSafetyFlags(flags: SafetyFlags): void {
    this._safetyFlags = flags;
  }

  getSafetyFlags(): SafetyFlags {
    return this._safetyFlags;
  }
}

const SERVER_INFO = { name: "artifacta", version: VERSION };
const SERVER_OPTIONS = {
  capabilities: {
    tools: { listChanged: false },
    resources: { subscribe: false, listChanged: false },
    prompts: {},
    logging: {},
  },
};

/**
 * Wire every JSON-RPC request handler onto `srv`. Extracted so the hosted HTTP
 * transport can mint a fresh server per request (stateless mode — see
 * src/http/transport.ts) while stdio keeps the long-lived singleton below.
 * Handlers read per-call state (client capabilities, safety flags) off `srv`,
 * never the module singleton, so per-request instances stay isolated.
 */
function wireHandlers(srv: ArtifactaServer): void {
  srv.setRequestHandler(ListToolsRequestSchema, async () => {
    const caps = srv.getClientCapabilities();
    const flags = srv.getSafetyFlags();
    const hasConfirmations = !!caps?.experimental?.["confirmations"];
    return {
      tools: getFilteredTools({
        hasConfirmations,
        allowDestructive: flags.allowDestructive,
        writeConfirmRequired: flags.writeConfirmRequired,
      }),
    };
  });

  srv.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const reg = getToolRegistration(name);
    if (!reg) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    const caps = srv.getClientCapabilities();
    const flags = srv.getSafetyFlags();
    const hasConfirmations = !!caps?.experimental?.["confirmations"];

    // Enforce the same gate as tools/list: block direct calls to destructive tools
    // when the client has no confirmation surface and --allow-destructive was not set.
    // Using MethodNotFound so the client cannot distinguish "blocked" from "absent".
    if (!isCallPermitted(reg, hasConfirmations, flags.allowDestructive)) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    // Audit destructive calls when --allow-destructive is the sole reason they're exposed
    if (reg.safety === "destructive" && flags.allowDestructive && !hasConfirmations) {
      emitDestructiveAudit(name, req.params.arguments);
    }

    const requestId = randomUUID();
    const start = performance.now();
    logger.debug("tool dispatch", { tool: name, request_id: requestId });

    let success = true;
    let errorCode: string | undefined;
    try {
      const result = await reg.handler(req.params.arguments, { requestId });

      if (result.isError) {
        success = false;
        const meta = result._meta as { code?: unknown } | undefined;
        if (meta && typeof meta.code === "string") errorCode = meta.code;
      }

      return {
        ...result,
        _meta: { ...(result._meta ?? {}), request_id: requestId },
      };
    } catch (err) {
      success = false;
      if (err instanceof McpError) {
        errorCode = "mcp_error";
      } else {
        errorCode = "internal_error";
      }
      logger.error("tool handler threw", {
        tool: name,
        request_id: requestId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      const latencyMs = Math.max(1, Math.round(performance.now() - start));
      emitTelemetry({
        tool_name: name,
        latency_ms: latencyMs,
        success,
        error_code: errorCode,
        server_version: VERSION,
      });
    }
  });

  registerSetLevelHandler(srv);

  srv.setRequestHandler(ListResourcesRequestSchema, async () => {
    // Static resources (always present) + dynamic recent-artifact enumeration
    // per plan §3. The recent-artifact call is best-effort: a transient API
    // failure must not break resources/list — the static surface still serves.
    const statics = listResources();
    const recent = await fetchRecentArtifactResources();
    return { resources: [...statics, ...recent] };
  });
  srv.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    const exact = getResourceReader(uri);
    if (exact) return exact(uri);
    const tmpl = matchResourceTemplate(uri);
    if (tmpl) return tmpl.read(uri, tmpl.params);
    throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${uri}`);
  });
  srv.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: listResourceTemplates(),
  }));
  srv.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [],
  }));

  // Handle `shutdown` JSON-RPC request: respond then exit 0 gracefully.
  // Not standard MCP, but required by plan §1.2 lifecycle spec.
  srv.fallbackRequestHandler = async (request) => {
    const method = (request as unknown as { method: string }).method;
    if (method === "shutdown") {
      setImmediate(() => process.exit(0));
      return {};
    }
    throw new McpError(ErrorCode.MethodNotFound, `Method not found: ${method}`);
  };
}

/** Build a fully-wired server instance. Used per-request by the HTTP transport. */
export function createArtifactaServer(): ArtifactaServer {
  const srv = new ArtifactaServer(SERVER_INFO, SERVER_OPTIONS);
  wireHandlers(srv);
  return srv;
}

/** Long-lived singleton used by the stdio entrypoint (cli.ts) and unit tests. */
export const server = createArtifactaServer();

// Failure escalation: when 3 consecutive HTTP failures land, surface a single
// MCP `notifications/message` at level=error per plan §6.3 and keep serving.
// Bound to the stdio singleton: stateless HTTP cannot push server-initiated
// notifications in JSON-response mode, and its per-request servers are too
// short-lived to own this, so the notifier no-ops there (the singleton is never
// connected to an HTTP transport). The underlying failure counter in
// escalation/tracker is process-global; acceptable for the Phase 0 canary.
setOutageNotifier((message) => {
  void server
    .sendLoggingMessage({ level: "error", data: message })
    .catch((err: unknown) => {
      logger.warning("failed to surface outage notification", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  logger.error(message);
});
