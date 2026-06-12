#!/usr/bin/env node
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { describe, test, expect } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");
const TSX = join(ROOT, "node_modules", ".bin", "tsx");
const CLI = join(ROOT, "src", "cli.ts");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as {
  version: string;
};

type JsonMsg = Record<string, unknown>;

function spawnServer(env?: Record<string, string>) {
  return spawn(TSX, [CLI], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: ROOT,
    env: { ...process.env, ...env },
  });
}

/** Read newline-delimited JSON messages from a stream */
function createReader(stream: NodeJS.ReadableStream) {
  let buf = "";
  const queue: JsonMsg[] = [];
  const waiters: ((msg: JsonMsg) => void)[] = [];

  stream.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8");
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const msg = JSON.parse(trimmed) as JsonMsg;
      const waiter = waiters.shift();
      if (waiter) {
        waiter(msg);
      } else {
        queue.push(msg);
      }
    }
  });

  return {
    next(timeoutMs = 5000): Promise<JsonMsg> {
      return new Promise((resolve, reject) => {
        if (queue.length > 0) {
          resolve(queue.shift()!);
          return;
        }
        const timer = setTimeout(
          () => reject(new Error("read timeout")),
          timeoutMs
        );
        waiters.push((msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
      });
    },
    /** Read messages until predicate matches; earlier messages are discarded */
    nextWhere(
      pred: (msg: JsonMsg) => boolean,
      timeoutMs = 5000
    ): Promise<JsonMsg> {
      const deadline = Date.now() + timeoutMs;
      const tryNext = (): Promise<JsonMsg> =>
        this.next(Math.max(deadline - Date.now(), 100)).then((msg) =>
          pred(msg) ? msg : tryNext()
        );
      return tryNext();
    },
  };
}

/** Capture stderr as a string from a child process */
function captureStderr(child: ReturnType<typeof spawnServer>): () => string {
  let buf = "";
  child.stderr.on("data", (c: Buffer) => (buf += c.toString()));
  return () => buf;
}

/** Send a newline-terminated JSON-RPC message to stdin */
function send(child: ReturnType<typeof spawnServer>, msg: JsonMsg): void {
  child.stdin.write(JSON.stringify(msg) + "\n");
}

const INIT_REQUEST: JsonMsg = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    clientInfo: { name: "test-client", version: "0.0.0" },
    capabilities: {},
  },
};

const INITIALIZED_NOTIF: JsonMsg = {
  jsonrpc: "2.0",
  method: "notifications/initialized",
  params: {},
};

async function initServer(child: ReturnType<typeof spawnServer>) {
  const reader = createReader(child.stdout);
  send(child, INIT_REQUEST);
  await reader.next(); // consume initialize response
  send(child, INITIALIZED_NOTIF);
  return reader;
}

describe("MCP server bootstrap (AF_MCP-1.1)", () => {
  // AF_MCP-1.1.01
  test("--version flag prints version and exits 0", async () => {
    const child = spawn(TSX, [CLI, "--version"], { stdio: "pipe", cwd: ROOT });
    let stdout = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    const code = await new Promise<number>((resolve) =>
      child.on("close", resolve)
    );
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  // AF_MCP-1.1.02
  test("--help flag prints usage text and exits 0", async () => {
    const child = spawn(TSX, [CLI, "--help"], { stdio: "pipe", cwd: ROOT });
    let stdout = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    const code = await new Promise<number>((resolve) =>
      child.on("close", resolve)
    );
    expect(code).toBe(0);
    expect(stdout).toContain("artifacta-mcp");
    expect(stdout).toContain("Usage");
  });

  // AF_MCP-1.1.03 + AF_MCP-1.1.04
  test("initialize response matches plan §1.2 capabilities; version matches package.json", async () => {
    const child = spawnServer();
    const reader = createReader(child.stdout);

    send(child, INIT_REQUEST);
    const response = await reader.next();

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(1);

    const result = response.result as Record<string, unknown>;
    expect(result).toBeDefined();

    // serverInfo block: name must be "artifacta", version must match package.json
    const serverInfo = result.serverInfo as Record<string, unknown>;
    expect(serverInfo.name).toBe("artifacta");
    expect(serverInfo.version).toBe(PKG.version); // AF_MCP-1.1.04

    // capabilities block
    const caps = result.capabilities as Record<string, unknown>;
    const tools = caps.tools as Record<string, unknown>;
    expect(tools.listChanged).toBe(false);

    const resources = caps.resources as Record<string, unknown>;
    expect(resources.listChanged).toBe(false);
    expect(resources.subscribe).toBe(false);

    // prompts and logging advertised
    expect(caps.prompts).toBeDefined();
    expect(caps.logging).toBeDefined();

    child.stdin.end();
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
  });

  // AF_MCP-1.1.05 — Phase 1 baseline was an empty array; from Phase 4 (AF_MCP-2.1)
  // the registered tool surface starts populating, so this asserts shape + the
  // always-present `whoami` entry rather than length 0.
  test("tools/list returns the registered tool surface (whoami present)", async () => {
    const child = spawnServer();
    const reader = await initServer(child);

    send(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const response = await reader.next();
    const result = response.result as Record<string, unknown>;
    expect(Array.isArray(result.tools)).toBe(true);
    const tools = result.tools as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toContain("whoami");

    child.stdin.end();
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
  });

  // AF_MCP-1.1.06 — same Phase-4 update: artifacta://whoami is always present.
  test("resources/list always includes artifacta://whoami", async () => {
    const child = spawnServer();
    const reader = await initServer(child);

    send(child, {
      jsonrpc: "2.0",
      id: 3,
      method: "resources/list",
      params: {},
    });
    const response = await reader.next();
    const result = response.result as Record<string, unknown>;
    expect(Array.isArray(result.resources)).toBe(true);
    const resources = result.resources as Array<{
      uri: string;
      mimeType?: string;
    }>;
    const whoami = resources.find((r) => r.uri === "artifacta://whoami");
    expect(whoami).toBeDefined();
    expect(whoami!.mimeType).toBe("application/json");

    child.stdin.end();
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
  });

  // AF_MCP-1.1.07 — Phase 1 baseline was an empty array; from Phase 4
  // (AF_MCP-2.3) the artifact resource template is registered, so this
  // asserts shape + the template's presence.
  test("resources/templates/list includes artifacta://artifact/{artifact_id}", async () => {
    const child = spawnServer();
    const reader = await initServer(child);

    send(child, {
      jsonrpc: "2.0",
      id: 4,
      method: "resources/templates/list",
      params: {},
    });
    const response = await reader.next();
    const result = response.result as Record<string, unknown>;
    expect(Array.isArray(result.resourceTemplates)).toBe(true);
    const templates = result.resourceTemplates as Array<{
      uriTemplate: string;
      mimeType?: string;
    }>;
    const artifact = templates.find(
      (t) => t.uriTemplate === "artifacta://artifact/{artifact_id}"
    );
    expect(artifact).toBeDefined();
    expect(artifact!.mimeType).toBe("application/json");

    child.stdin.end();
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
  });

  // AF_MCP-1.1.08
  test("shutdown JSON-RPC method exits 0 within 5 seconds", async () => {
    const child = spawnServer();
    const reader = await initServer(child);

    const start = Date.now();
    send(child, { jsonrpc: "2.0", id: 5, method: "shutdown", params: {} });

    const code = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("did not exit within 5s")),
        5500
      );
      child.on("close", (c) => {
        clearTimeout(timer);
        resolve(c ?? 0);
      });
    });

    expect(code).toBe(0);
    expect(Date.now() - start).toBeLessThan(5500);
  });

  // AF_MCP-1.1.09
  test("stdin EOF triggers graceful shutdown within 5 seconds", async () => {
    const child = spawnServer();
    const reader = createReader(child.stdout);

    send(child, INIT_REQUEST);
    await reader.next();

    const start = Date.now();
    child.stdin.end();

    const code = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("process did not exit within 5s")),
        5500
      );
      child.on("close", (c) => {
        clearTimeout(timer);
        resolve(c ?? 0);
      });
    });

    expect(code).toBe(0);
    expect(Date.now() - start).toBeLessThan(5500);
  });

  // AF_MCP-1.1.10
  test("SIGTERM triggers graceful shutdown within 5 seconds", async () => {
    const child = spawnServer();
    await initServer(child);

    const start = Date.now();
    child.kill("SIGTERM");

    const code = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("did not exit within 5s after SIGTERM")),
        5500
      );
      child.on("close", (c) => {
        clearTimeout(timer);
        resolve(c ?? 0);
      });
    });

    expect(code).toBe(0);
    expect(Date.now() - start).toBeLessThan(5500);
  });

  // AF_MCP-1.1.11
  test("uncaughtException emits notifications/message at level:error; server continues serving", async () => {
    const child = spawnServer({ _ARTIFACTA_TEST_INJECT_EXCEPTION: "1" });
    const reader = await initServer(child);

    // The injected exception fires ~300ms after startup.
    // Read the next message — should be a notifications/message with level:error.
    const notification = await reader.next(4000);

    expect(notification.method).toBe("notifications/message");
    const params = notification.params as Record<string, unknown>;
    expect(params.level).toBe("error");

    // Server must still respond to subsequent requests
    send(child, { jsonrpc: "2.0", id: 6, method: "tools/list", params: {} });
    const response = await reader.next(3000);
    const result = response.result as Record<string, unknown>;
    expect(Array.isArray(result.tools)).toBe(true);

    child.stdin.end();
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
  });

  // AF_MCP-1.1.12
  test("malformed JSON-RPC emits -32600 error response and error log; server does not crash", async () => {
    const child = spawnServer();
    const reader = await initServer(child);
    const getStderr = captureStderr(child);

    child.stdin.write('{"not":"valid-jsonrpc"}\n');

    // After malformed input the server emits a notifications/message then a -32600 response.
    // Use nextWhere to find the -32600 error response regardless of ordering.
    const errorResp = await reader.nextWhere(
      (m) => m.error !== undefined || m.id === null,
      3000
    );
    expect(errorResp.id).toBeNull();
    const error = errorResp.error as Record<string, unknown>;
    expect(error.code).toBe(-32600);

    // Error must also be logged to stderr
    await new Promise((r) => setTimeout(r, 100));
    expect(getStderr()).toContain("transport error");

    // Server must still respond to subsequent requests
    send(child, { jsonrpc: "2.0", id: 7, method: "tools/list", params: {} });
    const toolsResp = await reader.nextWhere((m) => m.id === 7, 3000);
    const result = toolsResp.result as Record<string, unknown>;
    expect(Array.isArray(result.tools)).toBe(true);

    child.stdin.end();
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
  });

  // AF_MCP-1.1.13
  test("binary garbage on stdin emits -32700 error response and error log; server does not crash", async () => {
    const child = spawnServer();
    const reader = await initServer(child);
    const getStderr = captureStderr(child);

    // Buffer with a trailing newline so the ReadBuffer attempts to parse it.
    // JSON.parse fails with SyntaxError → must respond with -32700 ParseError,
    // not -32600 InvalidRequest (which is for valid JSON that fails schema).
    child.stdin.write(Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x01, 0x0a]));

    // Find the -32700 error response
    const errorResp = await reader.nextWhere(
      (m) => m.error !== undefined || m.id === null,
      3000
    );
    expect(errorResp.id).toBeNull();
    const error = errorResp.error as Record<string, unknown>;
    expect(error.code).toBe(-32700);

    // Error must also be logged to stderr
    await new Promise((r) => setTimeout(r, 100));
    expect(getStderr()).toContain("transport error");

    // Server must still respond to subsequent requests
    send(child, { jsonrpc: "2.0", id: 8, method: "tools/list", params: {} });
    const toolsResp = await reader.nextWhere((m) => m.id === 8, 3000);
    const result = toolsResp.result as Record<string, unknown>;
    expect(Array.isArray(result.tools)).toBe(true);

    child.stdin.end();
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
  });

  // AF_MCP-1.1.14 — SKIP: requires local npm pack install; shebang present in src/cli.ts
  test.skip("bin field resolves via npx (AF_MCP-1.1.14)", () => {
    // Manual: npm pack && npm install -g @artifacta/mcp && artifacta-mcp --version
  });
});
