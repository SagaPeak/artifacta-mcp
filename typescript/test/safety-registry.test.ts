import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  registerTool,
  getFilteredTools,
  getToolRegistration,
  isCallPermitted,
  clearRegistry,
  type ToolSafety,
} from "../src/safety/registry.js";
import { parseSafetyFlags } from "../src/safety/flags.js";
import { emitDestructiveAudit } from "../src/safety/audit.js";

// Stub handler — real tools implement this in Phase 3/4
const noopHandler = async (): Promise<CallToolResult> => ({ content: [] });

function makeTool(name: string): Tool {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object" as const },
  };
}

function reg(name: string, safety: ToolSafety, opts: { alwaysConfirm?: boolean } = {}): void {
  registerTool(makeTool(name), safety, noopHandler, opts);
}

beforeEach(() => {
  clearRegistry();
});

// ─── tools/list filter matrix ────────────────────────────────────────────────

describe("getFilteredTools — compliant client (hasConfirmations=true)", () => {
  it("safe tool appears without requiresConfirmation", () => {
    reg("get_artifact", "safe");
    const tools = getFilteredTools({ hasConfirmations: true, allowDestructive: false, writeConfirmRequired: false });
    expect(tools).toHaveLength(1);
    expect(tools[0]._meta?.requiresConfirmation).toBeUndefined();
  });

  it("destructive tool appears with requiresConfirmation=true", () => {
    reg("delete_artifact", "destructive");
    const tools = getFilteredTools({ hasConfirmations: true, allowDestructive: false, writeConfirmRequired: false });
    expect(tools).toHaveLength(1);
    expect(tools[0]._meta?.requiresConfirmation).toBe(true);
  });

  it("alwaysConfirm tool appears with requiresConfirmation=true regardless of safety", () => {
    reg("create_download_link", "writeNonIdempotent", { alwaysConfirm: true });
    const tools = getFilteredTools({ hasConfirmations: true, allowDestructive: false, writeConfirmRequired: false });
    expect(tools).toHaveLength(1);
    expect(tools[0]._meta?.requiresConfirmation).toBe(true);
  });

  it("--allow-destructive flag does not change compliant-client behaviour", () => {
    reg("delete_artifact", "destructive");
    const tools = getFilteredTools({ hasConfirmations: true, allowDestructive: true, writeConfirmRequired: false });
    expect(tools).toHaveLength(1);
    expect(tools[0]._meta?.requiresConfirmation).toBe(true);
  });

  it("writeConfirmRequired promotes writeIdempotent tools to requiresConfirmation", () => {
    reg("store_artifact", "writeIdempotent");
    const tools = getFilteredTools({ hasConfirmations: true, allowDestructive: false, writeConfirmRequired: true });
    expect(tools[0]._meta?.requiresConfirmation).toBe(true);
  });

  it("writeConfirmRequired promotes writeNonIdempotent write-confirm tools", () => {
    reg("request_upload_url", "writeNonIdempotent");
    reg("complete_upload", "writeIdempotent");
    reg("create_download_link", "writeNonIdempotent", { alwaysConfirm: true });
    const tools = getFilteredTools({ hasConfirmations: true, allowDestructive: false, writeConfirmRequired: true });
    for (const t of tools) {
      expect(t._meta?.requiresConfirmation).toBe(true);
    }
  });

  it("writeConfirmRequired does NOT promote safe tools", () => {
    reg("list_artifacts", "safe");
    const tools = getFilteredTools({ hasConfirmations: true, allowDestructive: false, writeConfirmRequired: true });
    expect(tools[0]._meta?.requiresConfirmation).toBeUndefined();
  });

  it("existing _meta keys are preserved when requiresConfirmation is added", () => {
    const tool: Tool = {
      name: "delete_artifact",
      description: "del",
      inputSchema: { type: "object" as const },
      _meta: { customKey: "customValue" },
    };
    registerTool(tool, "destructive", noopHandler);
    const tools = getFilteredTools({ hasConfirmations: true, allowDestructive: false, writeConfirmRequired: false });
    expect(tools[0]._meta?.customKey).toBe("customValue");
    expect(tools[0]._meta?.requiresConfirmation).toBe(true);
  });
});

describe("getFilteredTools — non-compliant client (hasConfirmations=false)", () => {
  it("safe tool appears normally", () => {
    reg("list_artifacts", "safe");
    const tools = getFilteredTools({ hasConfirmations: false, allowDestructive: false, writeConfirmRequired: false });
    expect(tools).toHaveLength(1);
    expect(tools[0]._meta?.requiresConfirmation).toBeUndefined();
  });

  it("destructive tool is ABSENT (not just hidden)", () => {
    reg("delete_artifact", "destructive");
    reg("list_artifacts", "safe");
    const tools = getFilteredTools({ hasConfirmations: false, allowDestructive: false, writeConfirmRequired: false });
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("list_artifacts");
  });

  it("destructive tool is absent even when multiple destructive tools registered", () => {
    reg("delete_artifact", "destructive");
    reg("seal_session", "destructive");
    reg("list_artifacts", "safe");
    const tools = getFilteredTools({ hasConfirmations: false, allowDestructive: false, writeConfirmRequired: false });
    expect(tools).toHaveLength(1);
    expect(tools.some(t => t.name === "delete_artifact")).toBe(false);
    expect(tools.some(t => t.name === "seal_session")).toBe(false);
  });

  it("--allow-destructive restores destructive tools WITHOUT requiresConfirmation", () => {
    reg("delete_artifact", "destructive");
    const tools = getFilteredTools({ hasConfirmations: false, allowDestructive: true, writeConfirmRequired: false });
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("delete_artifact");
    // No requiresConfirmation for non-compliant clients
    expect(tools[0]._meta?.requiresConfirmation).toBeUndefined();
  });

  it("writeConfirmRequired has no effect on non-compliant client", () => {
    reg("store_artifact", "writeIdempotent");
    const tools = getFilteredTools({ hasConfirmations: false, allowDestructive: false, writeConfirmRequired: true });
    expect(tools[0]._meta?.requiresConfirmation).toBeUndefined();
  });

  it("alwaysConfirm tool appears WITHOUT requiresConfirmation for non-compliant client", () => {
    reg("create_download_link", "writeNonIdempotent", { alwaysConfirm: true });
    const tools = getFilteredTools({ hasConfirmations: false, allowDestructive: false, writeConfirmRequired: false });
    expect(tools).toHaveLength(1);
    expect(tools[0]._meta?.requiresConfirmation).toBeUndefined();
  });
});

// ─── parseSafetyFlags ────────────────────────────────────────────────────────

describe("parseSafetyFlags", () => {
  afterEach(() => {
    delete process.env.ARTIFACTA_MCP_REQUIRE_WRITE_CONFIRM;
    delete process.env.ALLOW_DESTRUCTIVE;
  });

  it("--allow-destructive in argv sets flag", () => {
    const flags = parseSafetyFlags(["--allow-destructive"]);
    expect(flags.allowDestructive).toBe(true);
  });

  it("allowDestructive is false with no flag", () => {
    const flags = parseSafetyFlags([]);
    expect(flags.allowDestructive).toBe(false);
  });

  it("ALLOW_DESTRUCTIVE env var does NOT set allowDestructive (security check)", () => {
    process.env.ALLOW_DESTRUCTIVE = "1";
    const flags = parseSafetyFlags([]);
    expect(flags.allowDestructive).toBe(false);
  });

  it("ARTIFACTA_MCP_REQUIRE_WRITE_CONFIRM=1 sets writeConfirmRequired", () => {
    process.env.ARTIFACTA_MCP_REQUIRE_WRITE_CONFIRM = "1";
    const flags = parseSafetyFlags([]);
    expect(flags.writeConfirmRequired).toBe(true);
  });

  it("ARTIFACTA_MCP_REQUIRE_WRITE_CONFIRM not set → false", () => {
    delete process.env.ARTIFACTA_MCP_REQUIRE_WRITE_CONFIRM;
    const flags = parseSafetyFlags([]);
    expect(flags.writeConfirmRequired).toBe(false);
  });

  it("ARTIFACTA_MCP_REQUIRE_WRITE_CONFIRM=0 → false", () => {
    process.env.ARTIFACTA_MCP_REQUIRE_WRITE_CONFIRM = "0";
    const flags = parseSafetyFlags([]);
    expect(flags.writeConfirmRequired).toBe(false);
  });

  it("--allow-destructive with other flags still detected", () => {
    const flags = parseSafetyFlags(["--api-key=ak_live_abc", "--allow-destructive", "--profile=staging"]);
    expect(flags.allowDestructive).toBe(true);
  });
});

// ─── getToolRegistration ─────────────────────────────────────────────────────

describe("getToolRegistration", () => {
  it("returns undefined for unknown tool", () => {
    expect(getToolRegistration("nonexistent")).toBeUndefined();
  });

  it("returns registration for known tool with correct safety", () => {
    reg("delete_artifact", "destructive");
    const r = getToolRegistration("delete_artifact");
    expect(r).toBeDefined();
    expect(r!.safety).toBe("destructive");
    expect(r!.handler).toBe(noopHandler);
  });
});

// ─── emitDestructiveAudit ────────────────────────────────────────────────────

describe("emitDestructiveAudit", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits correct format to stderr", () => {
    emitDestructiveAudit("delete_artifact", { artifact_id: "art_123" });
    const out = stderrSpy.mock.calls.map(c => String(c[0])).join("");
    expect(out).toContain("[artifacta-mcp] destructive call: delete_artifact(");
    expect(out).toContain("no confirmation surface");
    expect(out).toContain("art_123");
  });

  it("truncates args to 200 chars", () => {
    const longArgs = { data: "x".repeat(300) };
    emitDestructiveAudit("delete_artifact", longArgs);
    const out = stderrSpy.mock.calls.map(c => String(c[0])).join("");
    // Args string in output should be <= 200 + "..." suffix
    const match = out.match(/delete_artifact\((.+)\) — no confirmation/);
    expect(match).toBeTruthy();
    const argsInOutput = match![1];
    // The stringified args hit the 200-char limit
    expect(argsInOutput.length).toBeLessThanOrEqual(203); // 200 + "..."
  });

  it("redacts api_key values", () => {
    emitDestructiveAudit("delete_artifact", { api_key: "supersecretvalue123" });
    const out = stderrSpy.mock.calls.map(c => String(c[0])).join("");
    expect(out).not.toContain("supersecretvalue123");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts password values", () => {
    emitDestructiveAudit("some_tool", { password: "hunter2" });
    const out = stderrSpy.mock.calls.map(c => String(c[0])).join("");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("[REDACTED]");
  });

  it("does not redact non-secret fields", () => {
    emitDestructiveAudit("delete_artifact", { artifact_id: "art_abc123" });
    const out = stderrSpy.mock.calls.map(c => String(c[0])).join("");
    expect(out).toContain("art_abc123");
  });
});

// ─── Four-cell matrix (compliant × flag) ─────────────────────────────────────

describe("Four-cell matrix: {compliant, non-compliant} × {flag-set, flag-unset}", () => {
  beforeEach(() => {
    reg("delete_artifact", "destructive");
    reg("list_artifacts", "safe");
  });

  it("Cell 1: compliant + flag-unset → destructive shown with confirm", () => {
    const tools = getFilteredTools({ hasConfirmations: true, allowDestructive: false, writeConfirmRequired: false });
    const del = tools.find(t => t.name === "delete_artifact");
    expect(del).toBeDefined();
    expect(del!._meta?.requiresConfirmation).toBe(true);
  });

  it("Cell 2: compliant + flag-set → destructive shown with confirm (flag irrelevant)", () => {
    const tools = getFilteredTools({ hasConfirmations: true, allowDestructive: true, writeConfirmRequired: false });
    const del = tools.find(t => t.name === "delete_artifact");
    expect(del).toBeDefined();
    expect(del!._meta?.requiresConfirmation).toBe(true);
  });

  it("Cell 3: non-compliant + flag-unset → destructive absent", () => {
    const tools = getFilteredTools({ hasConfirmations: false, allowDestructive: false, writeConfirmRequired: false });
    expect(tools.find(t => t.name === "delete_artifact")).toBeUndefined();
    expect(tools.find(t => t.name === "list_artifacts")).toBeDefined();
  });

  it("Cell 4: non-compliant + flag-set → destructive present, no requiresConfirmation", () => {
    const tools = getFilteredTools({ hasConfirmations: false, allowDestructive: true, writeConfirmRequired: false });
    const del = tools.find(t => t.name === "delete_artifact");
    expect(del).toBeDefined();
    expect(del!._meta?.requiresConfirmation).toBeUndefined();
  });
});

// ─── Env override for write-confirm ──────────────────────────────────────────

describe("ARTIFACTA_MCP_REQUIRE_WRITE_CONFIRM env override", () => {
  afterEach(() => {
    delete process.env.ARTIFACTA_MCP_REQUIRE_WRITE_CONFIRM;
  });

  it("store_artifact gets requiresConfirmation when env=1 and client is compliant", () => {
    process.env.ARTIFACTA_MCP_REQUIRE_WRITE_CONFIRM = "1";
    reg("store_artifact", "writeIdempotent");
    const { writeConfirmRequired } = parseSafetyFlags([]);
    const tools = getFilteredTools({ hasConfirmations: true, allowDestructive: false, writeConfirmRequired });
    expect(tools[0]._meta?.requiresConfirmation).toBe(true);
  });

  it("complete_upload gets requiresConfirmation when env=1 and client is compliant", () => {
    process.env.ARTIFACTA_MCP_REQUIRE_WRITE_CONFIRM = "1";
    reg("complete_upload", "writeIdempotent");
    const { writeConfirmRequired } = parseSafetyFlags([]);
    const tools = getFilteredTools({ hasConfirmations: true, allowDestructive: false, writeConfirmRequired });
    expect(tools[0]._meta?.requiresConfirmation).toBe(true);
  });

  it("list_artifacts NOT affected by write-confirm env", () => {
    process.env.ARTIFACTA_MCP_REQUIRE_WRITE_CONFIRM = "1";
    reg("list_artifacts", "safe");
    const { writeConfirmRequired } = parseSafetyFlags([]);
    const tools = getFilteredTools({ hasConfirmations: true, allowDestructive: false, writeConfirmRequired });
    expect(tools[0]._meta?.requiresConfirmation).toBeUndefined();
  });
});

// ─── isCallPermitted — server-side call-time gate ────────────────────────────
// Mirrors the tools/list filter and must block direct tool calls, not just listing.

describe("isCallPermitted", () => {
  const destructiveReg = { safety: "destructive" as ToolSafety, alwaysConfirm: false, tool: makeTool("delete_artifact"), handler: noopHandler };
  const safeReg = { safety: "safe" as ToolSafety, alwaysConfirm: false, tool: makeTool("list_artifacts"), handler: noopHandler };
  const writeReg = { safety: "writeIdempotent" as ToolSafety, alwaysConfirm: false, tool: makeTool("store_artifact"), handler: noopHandler };

  it("safe tool is always permitted regardless of client capability", () => {
    expect(isCallPermitted(safeReg, false, false)).toBe(true);
    expect(isCallPermitted(safeReg, true, false)).toBe(true);
    expect(isCallPermitted(safeReg, false, true)).toBe(true);
  });

  it("write tool is always permitted", () => {
    expect(isCallPermitted(writeReg, false, false)).toBe(true);
    expect(isCallPermitted(writeReg, true, false)).toBe(true);
  });

  it("destructive tool BLOCKED for non-compliant client without --allow-destructive", () => {
    expect(isCallPermitted(destructiveReg, false, false)).toBe(false);
  });

  it("destructive tool PERMITTED for compliant client (has confirmations)", () => {
    expect(isCallPermitted(destructiveReg, true, false)).toBe(true);
  });

  it("destructive tool PERMITTED when --allow-destructive is set (non-compliant)", () => {
    expect(isCallPermitted(destructiveReg, false, true)).toBe(true);
  });

  it("destructive tool PERMITTED when both compliant AND --allow-destructive set", () => {
    expect(isCallPermitted(destructiveReg, true, true)).toBe(true);
  });

  it("blocks direct call even when tool was omitted from tools/list", () => {
    // This test represents the core fix: a client bypassing tools/list by calling directly.
    // The gate must be enforced at call time, not only at discovery time.
    const hasConfirmations = false;
    const allowDestructive = false;
    // Tool absent from tools/list — but can it be called directly?
    expect(isCallPermitted(destructiveReg, hasConfirmations, allowDestructive)).toBe(false);
  });
});
