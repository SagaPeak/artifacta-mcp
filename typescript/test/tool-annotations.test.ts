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
  "publish_artifact",
  "unpublish_artifact",
]);

const ALL_13 = new Set([...READ_TOOLS, ...WRITE_TOOLS, ...DESTRUCTIVE_TOOLS]);
const OPEN_WORLD_TOOLS = new Set([
  "create_download_link",
  "publish_artifact",
  "unpublish_artifact",
]);

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

  it("registers all 13 production tools", () => {
    const names = new Set(snapshotTools().map((t) => t.name));
    expect(names).toEqual(ALL_13);
  });

  for (const name of READ_TOOLS) {
    it(`${name} → explicit read-only, closed-world, non-destructive hints`, () => {
      const tool = snapshotTools().find((t) => t.name === name);
      expect(tool?.annotations).toEqual({
        readOnlyHint: true,
        openWorldHint: false,
        destructiveHint: false,
      });
    });
  }

  for (const name of WRITE_TOOLS) {
    it(`${name} → explicit private-write hints`, () => {
      const tool = snapshotTools().find((t) => t.name === name);
      expect(tool?.annotations).toEqual(
        name === "store_artifact"
          ? {
              readOnlyHint: false,
              openWorldHint: false,
              destructiveHint: false,
              idempotentHint: true,
            }
          : {
              readOnlyHint: false,
              openWorldHint: false,
              destructiveHint: false,
            }
      );
    });
  }

  it("store_artifact → idempotentHint: true", () => {
    const tool = snapshotTools().find((t) => t.name === "store_artifact");
    expect(tool?.annotations?.idempotentHint).toBe(true);
  });

  for (const name of DESTRUCTIVE_TOOLS) {
    it(`${name} → explicit destructive hints`, () => {
      const tool = snapshotTools().find((t) => t.name === name);
      expect(tool?.annotations).toEqual({
        readOnlyHint: false,
        openWorldHint: OPEN_WORLD_TOOLS.has(name),
        destructiveHint: true,
      });
    });
  }
});
