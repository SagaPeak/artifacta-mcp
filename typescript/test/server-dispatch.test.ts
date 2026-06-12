import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CallToolRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { server } from "../src/server.js";
import { registerTool, clearRegistry, type ToolCallContext } from "../src/safety/registry.js";
import {
  setTelemetryMode,
  setTelemetryTransport,
  resetTelemetry,
  ALLOWED_TELEMETRY_FIELDS,
} from "../src/telemetry/emitter.js";
import { resetLogger, setLogWriter } from "../src/log/logger.js";

/**
 * The low-level SDK Server doesn't expose a public dispatcher; we capture
 * the registered CallTool handler at registration time via a sniff server.
 * The production server.ts already wires the same handler to the singleton,
 * so behavior is shared.
 */
async function dispatchCall(
  toolName: string,
  args?: Record<string, unknown>
): Promise<CallToolResult> {
  // Re-import server.ts and grab the registered CallTool handler by spying
  // on setRequestHandler via the public surface — easier: just call the
  // handler we know is registered by re-using server's behaviour through
  // a synthetic invocation. The SDK does not let us reach inside.
  //
  // Instead: replay the same logic. Since the production handler is short
  // and we own it, we expose the dispatch path via the registry directly:
  // the request_id wrap + telemetry emission is what we test.
  //
  // We achieve coverage by triggering server's CallTool through the
  // request handler list. The cleanest path is to send a mock request via
  // the server's _onmessage pipeline. The Server class has a private
  // `_requestHandlers` Map; we cast to access for tests only.
  const handlers = (server as unknown as {
    _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
  })._requestHandlers;
  const handler = handlers.get("tools/call");
  if (!handler) throw new Error("CallTool handler not registered on server");
  const req = CallToolRequestSchema.parse({
    method: "tools/call",
    params: { name: toolName, arguments: args ?? {} },
  });
  const result = (await handler(req, { signal: new AbortController().signal })) as CallToolResult;
  return result;
}

describe("server tool dispatch — request_id, telemetry, _meta wiring", () => {
  let telemetryLines: string[] = [];

  beforeEach(() => {
    clearRegistry();
    resetTelemetry();
    resetLogger();
    setLogWriter(() => {});
    setTelemetryMode("on");
    telemetryLines = [];
    setTelemetryTransport((line) => telemetryLines.push(line));
  });

  afterEach(() => {
    clearRegistry();
    resetTelemetry();
    resetLogger();
  });

  it("generates a request_id per call and surfaces it under _meta.request_id", async () => {
    let receivedCtx: ToolCallContext | undefined;
    registerTool(
      {
        name: "ok_tool",
        description: "ok",
        inputSchema: { type: "object" as const },
      },
      "safe",
      async (_args, ctx) => {
        receivedCtx = ctx;
        return { content: [{ type: "text", text: "ok" }] };
      }
    );

    const result = await dispatchCall("ok_tool");

    expect(receivedCtx?.requestId).toBeTruthy();
    const meta = result._meta as { request_id?: string } | undefined;
    expect(meta?.request_id).toBeTruthy();
    expect(meta?.request_id).toBe(receivedCtx?.requestId);
    // UUID v4 shape (lower bound)
    expect(meta?.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });

  it("each call gets a fresh request_id", async () => {
    registerTool(
      {
        name: "ok_tool",
        description: "ok",
        inputSchema: { type: "object" as const },
      },
      "safe",
      async () => ({ content: [{ type: "text", text: "ok" }] })
    );
    const a = await dispatchCall("ok_tool");
    const b = await dispatchCall("ok_tool");
    const aId = (a._meta as { request_id?: string }).request_id;
    const bId = (b._meta as { request_id?: string }).request_id;
    expect(aId).not.toBe(bId);
  });

  it("emits telemetry with the 5 allow-listed fields (success path)", async () => {
    registerTool(
      {
        name: "ok_tool",
        description: "ok",
        inputSchema: { type: "object" as const },
      },
      "safe",
      async () => ({ content: [{ type: "text", text: "ok" }] })
    );
    await dispatchCall("ok_tool");
    expect(telemetryLines).toHaveLength(1);
    const parsed = JSON.parse(telemetryLines[0]) as Record<string, unknown>;
    for (const k of Object.keys(parsed)) {
      expect(ALLOWED_TELEMETRY_FIELDS).toContain(k as keyof typeof parsed);
    }
    expect(parsed.tool_name).toBe("ok_tool");
    expect(parsed.success).toBe(true);
    expect(typeof parsed.latency_ms).toBe("number");
    expect((parsed.latency_ms as number) >= 1).toBe(true);
    expect(typeof parsed.server_version).toBe("string");
  });

  it("emits telemetry with success=false and error_code when handler returns isError", async () => {
    const ARG_ID = "art_thisIsTheUserArgumentValue";
    registerTool(
      {
        name: "err_tool",
        description: "err",
        inputSchema: { type: "object" as const },
      },
      "safe",
      async () => ({
        isError: true,
        content: [{ type: "text", text: "not found" }],
        _meta: { code: "artifact_not_found", status: 404, retry_hint: "do_not_retry" },
      })
    );
    await dispatchCall("err_tool", { artifact_id: ARG_ID });
    expect(telemetryLines).toHaveLength(1);
    const parsed = JSON.parse(telemetryLines[0]) as Record<string, unknown>;
    expect(parsed.success).toBe(false);
    expect(parsed.error_code).toBe("artifact_not_found");

    // Tripwire: the argument value must NEVER appear in the telemetry payload.
    expect(telemetryLines[0]).not.toContain(ARG_ID);
  });

  it("emits telemetry with success=false even when handler throws McpError", async () => {
    registerTool(
      {
        name: "throw_tool",
        description: "throws",
        inputSchema: { type: "object" as const },
      },
      "safe",
      async () => {
        throw new McpError(ErrorCode.InternalError, "boom");
      }
    );
    await expect(dispatchCall("throw_tool")).rejects.toBeInstanceOf(McpError);
    expect(telemetryLines).toHaveLength(1);
    const parsed = JSON.parse(telemetryLines[0]) as Record<string, unknown>;
    expect(parsed.success).toBe(false);
    expect(parsed.error_code).toBe("mcp_error");
    expect(parsed.tool_name).toBe("throw_tool");
  });

  it("preserves existing handler _meta fields and adds request_id", async () => {
    registerTool(
      {
        name: "meta_tool",
        description: "meta",
        inputSchema: { type: "object" as const },
      },
      "safe",
      async () => ({
        content: [{ type: "text", text: "ok" }],
        _meta: { custom: "value", code: "ok" },
      })
    );
    const result = await dispatchCall("meta_tool");
    const meta = result._meta as Record<string, unknown>;
    expect(meta.custom).toBe("value");
    expect(meta.code).toBe("ok");
    expect(typeof meta.request_id).toBe("string");
  });

  it("does not emit telemetry when mode is off (default)", async () => {
    resetTelemetry();
    setTelemetryTransport((line) => telemetryLines.push(line));
    registerTool(
      {
        name: "ok_tool",
        description: "ok",
        inputSchema: { type: "object" as const },
      },
      "safe",
      async () => ({ content: [{ type: "text", text: "ok" }] })
    );
    await dispatchCall("ok_tool");
    expect(telemetryLines).toHaveLength(0);
  });
});
