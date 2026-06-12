import { SetLevelRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { isLogLevel, setLogLevel, logger } from "./logger.js";

/**
 * Wire the MCP `logging/setLevel` request to the local logger.
 * Per AF_MCP-1.7: subsequent log lines emit at the new level without restart.
 */
export function registerSetLevelHandler(server: Server): void {
  server.setRequestHandler(SetLevelRequestSchema, async (req) => {
    const level = req.params.level;
    if (!isLogLevel(level)) {
      // SDK schema already constrains the enum, but defensive: treat invalid
      // as a no-op rather than crashing the server.
      return {};
    }
    setLogLevel(level);
    logger.notice("log level changed", { level });
    return {};
  });
}
