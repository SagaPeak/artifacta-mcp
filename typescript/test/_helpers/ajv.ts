// Ajv 2020 strict-mode harness shared by the schema-validation suite.
// Per plan §9.1, every tool's `inputSchema` is validated with a real JSON Schema
// validator (not a hand-rolled check) so a regression in the schema shape — a
// missing `additionalProperties`, a malformed `pattern`, an unknown `format` —
// is caught at PR time.
//
// Future per-tool unit tests (Phases 4, 6, 8) compose with these helpers
// rather than re-instantiating Ajv themselves.

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Strict Ajv 2020 instance. `strict: true` rejects unknown keywords and
 * malformed schemas at compile time; `allErrors: true` reports every failure
 * (so a test failure surfaces all schema violations at once instead of one).
 */
export function makeAjv(): Ajv2020 {
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    allowUnionTypes: true,
    // strictRequired is incompatible with the JSON-Schema `oneOf`-of-bare-required
    // idiom that plan §2.5 mandates for `store_artifact`
    // (`oneOf: [{required:["content"]},{required:["path"]}]`). The required
    // properties ARE defined in the parent `properties` block; strictRequired
    // only inspects the local subschema and would reject the valid pattern.
    // The structural gate (additionalProperties:false, explicit required) is
    // enforced separately by checkToolSchemaContract.
    strictRequired: false,
  });
  addFormats(ajv);
  return ajv;
}

/**
 * Compile a tool's `inputSchema` with Ajv strict. Returns the validate fn or
 * throws with the Ajv compilation error if the schema itself is malformed
 * (e.g. unknown format, dangling $ref). This is the structural gate every
 * registered tool must clear.
 */
export function compileToolSchema(tool: Tool): ReturnType<Ajv2020["compile"]> {
  const ajv = makeAjv();
  return ajv.compile(tool.inputSchema as Record<string, unknown>);
}

/**
 * Structural invariants every MCP tool input schema must satisfy
 * (CLAUDE.md "MCP Protocol Specifics"):
 *  - `type: "object"`
 *  - `additionalProperties: false`
 *  - explicit `required` array (may be empty)
 *  - `properties` object (may be empty)
 *
 * Asserting these once via the harness means every tool author gets the
 * same gate without having to remember the convention.
 */
export interface ToolSchemaContractFailure {
  field: "type" | "additionalProperties" | "required" | "properties";
  expected: string;
  got: unknown;
}

export function checkToolSchemaContract(tool: Tool): ToolSchemaContractFailure[] {
  const failures: ToolSchemaContractFailure[] = [];
  const schema = tool.inputSchema as Record<string, unknown>;
  if (schema.type !== "object") {
    failures.push({ field: "type", expected: '"object"', got: schema.type });
  }
  if (schema.additionalProperties !== false) {
    failures.push({
      field: "additionalProperties",
      expected: "false",
      got: schema.additionalProperties,
    });
  }
  if (!Array.isArray(schema.required)) {
    failures.push({
      field: "required",
      expected: "array (may be empty)",
      got: schema.required,
    });
  }
  if (typeof schema.properties !== "object" || schema.properties === null) {
    failures.push({
      field: "properties",
      expected: "object (may be empty)",
      got: schema.properties,
    });
  }
  return failures;
}
