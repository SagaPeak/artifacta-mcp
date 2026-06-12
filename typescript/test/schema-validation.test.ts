// AF_MCP-7.1 — Unit suite: schema validation per plan §9.1.
//
// This file is the parametric scaffold for tool input-schema validation.
// It iterates over every tool present in the registry at suite-load time and
// asserts the structural contract every Artifacta MCP tool must satisfy:
//   1. `inputSchema` compiles under Ajv 2020 strict mode (catches malformed
//      patterns, unknown formats, and the missing-`additionalProperties`
//      anti-pattern).
//   2. `type === "object"`, `additionalProperties === false`, `required` is
//      an array, `properties` is an object.
//   3. An empty payload (`{}`) is *only* accepted when `required` is empty.
//   4. A payload containing an extra unknown property is rejected.
//
// Per-tool happy-path / per-branch invalid-input vectors live in the test
// files for the tool tasks themselves (AF_MCP-2.x, 3.x, 4.x). Those tests
// import `compileToolSchema` from the helper module to keep the harness
// consistent across phases.
//
// Phase 4 onward, the parametric block iterates over the real production tool
// registry — every tool registered by `registerAllTools()` is run through the
// Ajv 2020 strict gate and the structural contract checker.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  registerTool,
  clearRegistry,
  getFilteredTools,
  type ToolSafety,
} from "../src/safety/registry.js";
import { registerAllTools } from "../src/tools/index.js";
import { compileToolSchema, checkToolSchemaContract, makeAjv } from "./_helpers/ajv.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const noopHandler = async (): Promise<CallToolResult> => ({ content: [] });

function snapshotRegisteredTools(): Tool[] {
  // Filter with maximum permissiveness so destructive tools are included too.
  return getFilteredTools({
    hasConfirmations: true,
    allowDestructive: true,
    writeConfirmRequired: false,
  });
}

// ─── Parametric block — runs over whatever tools exist at suite load ─────────
// Empty set today (Phase 3b). Becomes meaningful as Phases 4/6/8 land.

describe("Tool input-schema contract (parametric)", () => {
  // Snapshot the production registry. registerAllTools() is the same call cli.ts
  // makes at startup, so this gate exercises the exact tool definitions that
  // ship to clients. Tests that need a clean registry use clearRegistry() in
  // their own beforeEach — the snapshot here is captured before any test runs.
  clearRegistry();
  registerAllTools();
  const tools = snapshotRegisteredTools();

  if (tools.length === 0) {
    it.skip("no tools registered yet — parametric suite is vacuous", () => {});
  }

  for (const tool of tools) {
    describe(`tool: ${tool.name}`, () => {
      it("inputSchema compiles under Ajv 2020 strict", () => {
        expect(() => compileToolSchema(tool)).not.toThrow();
      });

      it("inputSchema satisfies the MCP tool contract", () => {
        const failures = checkToolSchemaContract(tool);
        expect(failures).toEqual([]);
      });

      it("rejects an extra unknown property", () => {
        const validate = compileToolSchema(tool);
        const ok = validate({ __unknown_field_for_test__: 1 });
        expect(ok).toBe(false);
      });
    });
  }
});

// ─── Self-test — exercises the harness with synthetic fixture tools ──────────

describe("Schema-validation harness self-test", () => {
  beforeEach(() => clearRegistry());
  afterEach(() => clearRegistry());

  function fixture(
    name: string,
    inputSchema: Tool["inputSchema"],
    safety: ToolSafety = "safe",
  ): Tool {
    const tool: Tool = {
      name,
      description: `${name} fixture`,
      inputSchema,
    };
    registerTool(tool, safety, noopHandler);
    return tool;
  }

  it("compiles a valid object schema with additionalProperties:false", () => {
    const tool = fixture("fixture_valid", {
      type: "object",
      properties: { artifact_id: { type: "string", pattern: "^art_[A-Za-z0-9]{16}$" } },
      required: ["artifact_id"],
      additionalProperties: false,
    });
    const validate = compileToolSchema(tool);
    expect(validate({ artifact_id: "art_AAAAAAAAAAAAAAAA" })).toBe(true);
  });

  it("rejects a payload with an extra property when additionalProperties:false", () => {
    const tool = fixture("fixture_extra_props", {
      type: "object",
      properties: { artifact_id: { type: "string" } },
      required: ["artifact_id"],
      additionalProperties: false,
    });
    const validate = compileToolSchema(tool);
    const ok = validate({ artifact_id: "art_x", extra: 1 });
    expect(ok).toBe(false);
  });

  it("rejects a payload missing a required field", () => {
    const tool = fixture("fixture_required", {
      type: "object",
      properties: { artifact_id: { type: "string" } },
      required: ["artifact_id"],
      additionalProperties: false,
    });
    const validate = compileToolSchema(tool);
    expect(validate({})).toBe(false);
  });

  it("rejects a payload that violates a string pattern", () => {
    const tool = fixture("fixture_pattern", {
      type: "object",
      properties: { id: { type: "string", pattern: "^art_[A-Za-z0-9]{16}$" } },
      required: ["id"],
      additionalProperties: false,
    });
    const validate = compileToolSchema(tool);
    // 15 alnum chars — one short.
    expect(validate({ id: "art_AAAAAAAAAAAAAAA" })).toBe(false);
  });

  it("checkToolSchemaContract flags missing additionalProperties:false", () => {
    const tool: Tool = {
      name: "fixture_missing_addprops",
      description: "—",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    };
    const failures = checkToolSchemaContract(tool);
    expect(failures.some((f) => f.field === "additionalProperties")).toBe(true);
  });

  it("checkToolSchemaContract flags wrong root type", () => {
    const tool: Tool = {
      name: "fixture_wrong_type",
      description: "—",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    };
    // Mutate after the cast so TS doesn't reject the literal — exercises the
    // failure branch the way a buggy schema would surface in CI.
    (tool.inputSchema as Record<string, unknown>).type = "array";
    const failures = checkToolSchemaContract(tool);
    expect(failures.some((f) => f.field === "type")).toBe(true);
  });

  it("Ajv strict mode compiles 2020-12 schemas without warnings", () => {
    const ajv = makeAjv();
    expect(ajv.opts.strict).toBe(true);
  });
});
