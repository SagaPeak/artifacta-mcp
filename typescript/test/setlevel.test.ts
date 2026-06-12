import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SetLevelRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { registerSetLevelHandler } from "../src/log/setlevel.js";
import { getLogLevel, resetLogger, setLogWriter } from "../src/log/logger.js";

function makeServer(): Server {
  return new Server(
    { name: "test", version: "0.0.0" },
    { capabilities: { logging: {} } }
  );
}

describe("logging/setLevel handler", () => {
  beforeEach(() => {
    resetLogger();
    setLogWriter(() => {});
  });

  afterEach(() => {
    resetLogger();
  });

  it("sets the log level on a valid request", async () => {
    const server = makeServer();
    registerSetLevelHandler(server);

    // Build a request matching the SDK schema
    const parsed = SetLevelRequestSchema.parse({
      method: "logging/setLevel",
      params: { level: "debug" },
    });

    // Invoke the registered handler. The SDK low-level Server doesn't expose
    // a public dispatcher in tests; instead we look up the handler via the
    // schema name and call it directly. The registered handler closes over
    // setLogLevel, so calling it mutates the singleton.
    // Surface: the only observable side effect we need is that getLogLevel()
    // reflects the new value. Achieve that by simulating dispatch through
    // setRequestHandler is owned by SDK internals — instead, re-use the
    // public API: register on a fresh server and invoke the handler we
    // captured.
    const captured: Array<(req: typeof parsed) => Promise<unknown>> = [];
    const sniffServer = new Server(
      { name: "sniff", version: "0.0.0" },
      { capabilities: { logging: {} } }
    );
    const realSet = sniffServer.setRequestHandler.bind(sniffServer);
    sniffServer.setRequestHandler = ((schema: unknown, handler: (req: typeof parsed) => Promise<unknown>) => {
      captured.push(handler);
      return realSet(schema as Parameters<typeof realSet>[0], handler as Parameters<typeof realSet>[1]);
    }) as typeof sniffServer.setRequestHandler;

    registerSetLevelHandler(sniffServer);
    expect(captured).toHaveLength(1);
    await captured[0](parsed);
    expect(getLogLevel()).toBe("debug");
  });

  it("ignores invalid level strings (no throw, no mutation)", async () => {
    // The SDK's Zod schema would normally reject invalid levels at parse
    // time. Our handler also defends against junk, returning empty without
    // mutating the level.
    const captured: Array<(req: { params: { level: string } }) => Promise<unknown>> = [];
    const sniffServer = new Server(
      { name: "sniff", version: "0.0.0" },
      { capabilities: { logging: {} } }
    );
    const realSet = sniffServer.setRequestHandler.bind(sniffServer);
    sniffServer.setRequestHandler = ((schema: unknown, handler: (req: { params: { level: string } }) => Promise<unknown>) => {
      captured.push(handler);
      return realSet(schema as Parameters<typeof realSet>[0], handler as Parameters<typeof realSet>[1]);
    }) as typeof sniffServer.setRequestHandler;
    registerSetLevelHandler(sniffServer);

    const before = getLogLevel();
    const result = await captured[0]({ params: { level: "nonsense" } });
    expect(result).toEqual({});
    expect(getLogLevel()).toBe(before);
  });
});
