import { describe, it, expect, beforeEach } from "vitest";
import { clearRegistry, getFilteredTools } from "../src/safety/registry.js";
import { registerAllTools } from "../src/tools/index.js";

const READ_TOOLS = new Set([
  "whoami",
  "list_artifacts",
  "get_artifact",
  "get_artifact_download_url",
  "list_sessions",
]);

const WRITE_TOOLS = new Set([
  "store_artifact",
  "request_upload_url",
  "complete_upload",
]);

const DESTRUCTIVE_TOOLS = new Set([
  "create_download_link",
  "delete_artifact",
  "seal_session",
]);

const ALL_11 = new Set([...READ_TOOLS, ...WRITE_TOOLS, ...DESTRUCTIVE_TOOLS]);

function snapshotTools() {
  return getFilteredTools({
    hasConfirmations: true,
    allowDestructive: true,
    writeConfirmRequired: false,
  });
}

describe("Tool safety annotations (AF_MCP-REG-2)", () => {
  beforeEach(() => {
    clearRegistry();
    registerAllTools();
  });

  it("registers all 11 production tools", () => {
    const names = new Set(snapshotTools().map((t) => t.name));
    expect(names).toEqual(ALL_11);
  });

  for (const name of READ_TOOLS) {
    it(`${name} → readOnlyHint: true`, () => {
      const tool = snapshotTools().find((t) => t.name === name);
      expect(tool?.annotations).toEqual({ readOnlyHint: true });
    });
  }

  for (const name of WRITE_TOOLS) {
    it(`${name} → readOnlyHint: false`, () => {
      const tool = snapshotTools().find((t) => t.name === name);
      expect(tool?.annotations?.readOnlyHint).toBe(false);
      expect(tool?.annotations?.destructiveHint).toBeUndefined();
    });
  }

  it("store_artifact → idempotentHint: true", () => {
    const tool = snapshotTools().find((t) => t.name === "store_artifact");
    expect(tool?.annotations).toEqual({ readOnlyHint: false, idempotentHint: true });
  });

  for (const name of DESTRUCTIVE_TOOLS) {
    it(`${name} → destructiveHint: true`, () => {
      const tool = snapshotTools().find((t) => t.name === name);
      expect(tool?.annotations).toEqual({ destructiveHint: true });
    });
  }
});
