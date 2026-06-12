import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

const GRACE_MS = 5000;

export function registerShutdownHandlers(server: Server): void {
  let closing = false;

  async function shutdown(): Promise<void> {
    if (closing) return;
    closing = true;

    // Force-exit backstop — unref'd so it doesn't prevent clean exit
    const timer = setTimeout(() => process.exit(0), GRACE_MS);
    timer.unref();

    try {
      await server.close();
    } catch {
      // ignore close errors during shutdown
    }
    clearTimeout(timer);
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown());
  process.stdin.on("end", () => void shutdown());
}
