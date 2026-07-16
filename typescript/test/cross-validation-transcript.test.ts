import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LIST_ARTIFACTS_TOOL, listArtifactsHandler } from "../src/tools/list-artifacts.js";
import { STORE_ARTIFACT_TOOL, storeArtifactHandler } from "../src/tools/store-artifact.js";
import {
  resolveTranscriptListFilter,
  resolveTranscriptWriteDefaults,
} from "../src/tools/transcript.js";

interface StoreInput {
  transcript?: boolean;
  content_type?: string;
  metadata?: Record<string, string>;
  model?: string;
}

interface StoreCase {
  id: string;
  input: StoreInput;
  expected: { content_type: string | null; metadata: Record<string, string> | null };
}

interface ListInput {
  transcript?: boolean;
  metadata?: Record<string, string>;
}

interface ListCase {
  id: string;
  input: ListInput;
  expected_metadata: Record<string, string> | null;
}

interface Fixture {
  store_schema_property: Record<string, unknown>;
  list_schema_property: Record<string, unknown>;
  invalid_raw_values: unknown[];
  store_cases: StoreCase[];
  list_cases: ListCase[];
}

const fixture: Fixture = JSON.parse(
  readFileSync(resolve(__dirname, "../../shared/transcript-v1-fixture.json"), "utf8")
);

describe("AF_TRANSCRIPT-2.1 shared store fixture (TypeScript)", () => {
  it("matches the canonical store schema property", () => {
    const properties = STORE_ARTIFACT_TOOL.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties.transcript).toEqual(fixture.store_schema_property);
  });

  for (const c of fixture.store_cases) {
    it(`resolves ${c.id}`, () => {
      const originalMetadata = c.input.metadata;
      const resolved = resolveTranscriptWriteDefaults({
        contentType: c.input.content_type,
        metadata: originalMetadata,
        model: c.input.model,
        transcript: c.input.transcript ?? false,
      });
      expect({
        content_type: resolved.contentType ?? null,
        metadata: resolved.metadata ?? null,
      }).toEqual(c.expected);
      if (originalMetadata !== undefined) {
        expect(resolved.metadata).not.toBe(originalMetadata);
        expect(c.input.metadata).toBe(originalMetadata);
      }
    });
  }

  for (const value of fixture.invalid_raw_values) {
    it(`rejects invalid raw value ${JSON.stringify(value)} before I/O`, async () => {
      const result = await storeArtifactHandler({
        filename: "session.jsonl",
        path: "/definitely/not/read",
        transcript: value,
      });
      expect(result.isError).toBe(true);
      expect((result._meta as { code: string }).code).toBe("invalid_request");
    });
  }
});

describe("AF_TRANSCRIPT-2.2 shared list fixture (TypeScript)", () => {
  it("matches the canonical list schema property", () => {
    const properties = LIST_ARTIFACTS_TOOL.inputSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties.transcript).toEqual(fixture.list_schema_property);
  });

  for (const c of fixture.list_cases) {
    it(`resolves ${c.id}`, () => {
      const originalMetadata = c.input.metadata;
      const resolved = resolveTranscriptListFilter({
        metadata: originalMetadata,
        transcript: c.input.transcript ?? false,
      });
      expect(resolved ?? null).toEqual(c.expected_metadata);
      if (originalMetadata !== undefined) {
        expect(resolved).not.toBe(originalMetadata);
        expect(c.input.metadata).toBe(originalMetadata);
      }
    });
  }

  for (const value of fixture.invalid_raw_values) {
    it(`rejects invalid list value ${JSON.stringify(value)} before client acquisition`, async () => {
      const result = await listArtifactsHandler({ transcript: value });
      expect(result.isError).toBe(true);
      expect((result._meta as { code: string }).code).toBe("invalid_request");
    });
  }
});
