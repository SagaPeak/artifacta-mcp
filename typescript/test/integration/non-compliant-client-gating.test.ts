// AF_MCP-7.2.19–22 — Non-compliant client gating subsuite (Phase 3 hard gate).
//
// Per plan §5: a client that does NOT advertise `experimental.confirmations`
// in `initialize` must NOT see destructive tools in `tools/list`. The only
// override is the per-launch `--allow-destructive` CLI flag — and even then,
// every dispatch emits a stderr audit line.
//
// Phase 5 cut these against stub `delete_artifact` / `seal_session` registrations
// (the real handlers landed in Phase 8). Phase 9 re-points to the production
// `registerDeleteArtifactTool()` / `registerSealSessionTool()` so the suite
// exercises end-to-end safety-registry behaviour against the real tools — the
// same gating contract the Phase-8 unit tests pin, now executed via the
// integration entry point.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  clearRegistry,
  getFilteredTools,
  getToolRegistration,
} from "../../src/safety/registry.js";
import { emitDestructiveAudit } from "../../src/safety/audit.js";
import { registerDeleteArtifactTool } from "../../src/tools/delete-artifact.js";
import { registerSealSessionTool } from "../../src/tools/seal-session.js";

beforeEach(() => {
  clearRegistry();
  registerDeleteArtifactTool();
  registerSealSessionTool();
});

afterEach(() => {
  clearRegistry();
});

describe("AF_MCP-7.2.19 — `delete_artifact` absent without --allow-destructive (non-compliant client)", () => {
  it("real registerDeleteArtifactTool() registers a destructive tool", () => {
    const reg = getToolRegistration("delete_artifact");
    expect(reg).toBeDefined();
    expect(reg?.safety).toBe("destructive");
  });

  it("getFilteredTools returns no `delete_artifact` entry when client lacks confirmations", () => {
    const tools = getFilteredTools({
      hasConfirmations: false,
      allowDestructive: false,
      writeConfirmRequired: false,
    });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("delete_artifact");
  });
});

describe("AF_MCP-7.2.20 — `seal_session` absent without --allow-destructive (non-compliant client)", () => {
  it("real registerSealSessionTool() registers a destructive tool", () => {
    const reg = getToolRegistration("seal_session");
    expect(reg).toBeDefined();
    expect(reg?.safety).toBe("destructive");
  });

  it("getFilteredTools omits `seal_session` for non-compliant clients", () => {
    const tools = getFilteredTools({
      hasConfirmations: false,
      allowDestructive: false,
      writeConfirmRequired: false,
    });
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("seal_session");
  });
});

describe("AF_MCP-7.2.21 — Both tools appear with `--allow-destructive` (non-compliant client)", () => {
  it("getFilteredTools surfaces both real destructive tools when allowDestructive=true", () => {
    const tools = getFilteredTools({
      hasConfirmations: false,
      allowDestructive: true,
      writeConfirmRequired: false,
    });
    const names = tools.map((t) => t.name);
    expect(names).toContain("delete_artifact");
    expect(names).toContain("seal_session");
    // No requiresConfirmation meta on non-compliant + allowDestructive — there
    // is no confirmation surface to engage. The stderr warning is the only
    // visible safeguard (next test asserts that it fires).
    for (const tool of tools) {
      if (tool.name === "delete_artifact" || tool.name === "seal_session") {
        const meta = tool._meta as { requiresConfirmation?: unknown } | undefined;
        expect(meta?.requiresConfirmation).not.toBe(true);
      }
    }
  });

  it("compliant client (experimental.confirmations advertised) sees requiresConfirmation on both tools", () => {
    const tools = getFilteredTools({
      hasConfirmations: true,
      allowDestructive: false,
      writeConfirmRequired: false,
    });
    const byName = new Map(tools.map((t) => [t.name, t]));
    const del = byName.get("delete_artifact");
    const seal = byName.get("seal_session");
    expect(del).toBeDefined();
    expect(seal).toBeDefined();
    expect((del?._meta as { requiresConfirmation?: unknown } | undefined)?.requiresConfirmation).toBe(true);
    expect((seal?._meta as { requiresConfirmation?: unknown } | undefined)?.requiresConfirmation).toBe(true);
  });
});

describe("AF_MCP-7.2.22 — stderr audit line emitted on each destructive call (with --allow-destructive)", () => {
  it("emitDestructiveAudit writes the §5 warning line per call", () => {
    let captured = "";
    const realWrite = process.stderr.write.bind(process.stderr);
    const stub = (chunk: string | Uint8Array): boolean => {
      captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.stderr.write = stub as any;
    try {
      emitDestructiveAudit("delete_artifact", { artifact_id: "art_abc123" });
      emitDestructiveAudit("seal_session", { session_id: "build_2118" });
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      process.stderr.write = realWrite as any;
    }
    expect(captured).toContain(
      "[artifacta-mcp] destructive call: delete_artifact("
    );
    expect(captured).toContain(
      "[artifacta-mcp] destructive call: seal_session("
    );
    expect(captured).toContain("— no confirmation surface");
    // Trailing newline so each line is consumable by stderr-line readers.
    expect(captured.endsWith("\n")).toBe(true);
  });
});
