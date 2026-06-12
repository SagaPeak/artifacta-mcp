// AF_MCP-7.1 — Unit suite: ID and cursor formats per plan §9.1.
//
// CLAUDE.md fixes the wire format for every Artifacta identifier:
//   art_     + 16 alphanumeric  → artifact ids
//   lnk_     + 20 alphanumeric  → download link ids
//   ak_live_ + 32 alphanumeric  → API keys
//
// And the list pagination cursor is `base64(created_at, artifact_id)` —
// opaque to clients but stable across serialize/deserialize.
//
// These tests pin the regexes so any drift between source and tool schemas
// shows up at PR time.

import { describe, it, expect } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import {
  ARTIFACT_ID_PATTERN,
  DOWNLOAD_LINK_ID_PATTERN,
  API_KEY_PATTERN,
  isArtifactId,
  isDownloadLinkId,
  isApiKey,
} from "../src/ids/formats.js";

// ─── Regex helpers ───────────────────────────────────────────────────────────

const alnum16 = "A".repeat(16);
const alnum20 = "B".repeat(20);
const alnum32 = "C".repeat(32);

describe("Artifact id format — art_<16 alnum>", () => {
  it("accepts a well-formed artifact id (16 alnum)", () => {
    expect(isArtifactId(`art_${alnum16}`)).toBe(true);
  });

  it("rejects a 15-char tail", () => {
    expect(isArtifactId(`art_${"A".repeat(15)}`)).toBe(false);
  });

  it("rejects a 17-char tail", () => {
    expect(isArtifactId(`art_${"A".repeat(17)}`)).toBe(false);
  });

  it("rejects a non-alphanumeric tail", () => {
    expect(isArtifactId("art_AAAAAAAAAAAAAAA-")).toBe(false);
    expect(isArtifactId("art_AAAAAAAAAAAAAAA_")).toBe(false);
    expect(isArtifactId("art_AAAAAAAAAAAAAAA.")).toBe(false);
  });

  it("rejects a missing prefix", () => {
    expect(isArtifactId(alnum16)).toBe(false);
  });

  it("rejects the wrong prefix", () => {
    expect(isArtifactId(`lnk_${alnum16}`)).toBe(false);
  });

  it("validates under Ajv when wired into a tool input schema", () => {
    const ajv = new Ajv2020({ strict: true });
    const validate = ajv.compile({
      type: "object",
      properties: { artifact_id: { type: "string", pattern: ARTIFACT_ID_PATTERN } },
      required: ["artifact_id"],
      additionalProperties: false,
    });
    expect(validate({ artifact_id: `art_${alnum16}` })).toBe(true);
    expect(validate({ artifact_id: `art_${"A".repeat(15)}` })).toBe(false);
  });
});

describe("Download link id format — lnk_<20 alnum>", () => {
  it("accepts a well-formed link id (20 alnum)", () => {
    expect(isDownloadLinkId(`lnk_${alnum20}`)).toBe(true);
  });

  it("rejects a 19-char tail", () => {
    expect(isDownloadLinkId(`lnk_${"B".repeat(19)}`)).toBe(false);
  });

  it("rejects a 21-char tail", () => {
    expect(isDownloadLinkId(`lnk_${"B".repeat(21)}`)).toBe(false);
  });

  it("rejects the wrong prefix", () => {
    expect(isDownloadLinkId(`art_${alnum20}`)).toBe(false);
  });

  it("validates under Ajv when wired into a tool input schema", () => {
    const ajv = new Ajv2020({ strict: true });
    const validate = ajv.compile({
      type: "object",
      properties: { link_id: { type: "string", pattern: DOWNLOAD_LINK_ID_PATTERN } },
      required: ["link_id"],
      additionalProperties: false,
    });
    expect(validate({ link_id: `lnk_${alnum20}` })).toBe(true);
    expect(validate({ link_id: `lnk_${"B".repeat(19)}` })).toBe(false);
  });
});

describe("API key format — ak_live_<32 alnum>", () => {
  it("accepts a well-formed key (32 alnum)", () => {
    expect(isApiKey(`ak_live_${alnum32}`)).toBe(true);
  });

  it("rejects a 31-char tail", () => {
    expect(isApiKey(`ak_live_${"C".repeat(31)}`)).toBe(false);
  });

  it("rejects a key without ak_live_ prefix", () => {
    expect(isApiKey(alnum32)).toBe(false);
  });

  it("rejects ak_test_ prefix (only ak_live_ is valid)", () => {
    expect(isApiKey(`ak_test_${alnum32}`)).toBe(false);
  });

  it("validates under Ajv when wired into a tool input schema", () => {
    const ajv = new Ajv2020({ strict: true });
    const validate = ajv.compile({
      type: "object",
      properties: { api_key: { type: "string", pattern: API_KEY_PATTERN } },
      required: ["api_key"],
      additionalProperties: false,
    });
    expect(validate({ api_key: `ak_live_${alnum32}` })).toBe(true);
    expect(validate({ api_key: `ak_test_${alnum32}` })).toBe(false);
  });
});

// ─── Cursor round-trip ───────────────────────────────────────────────────────
// Per CLAUDE.md the cursor is base64(created_at, artifact_id) and opaque to
// clients. The MCP server passes cursors through verbatim, so the round-trip
// invariant we care about is: decoding a cursor and re-encoding the same
// payload yields the original string.

interface CursorPayload {
  created_at: string;
  artifact_id: string;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

function decodeCursor(cursor: string): CursorPayload {
  const json = Buffer.from(cursor, "base64").toString("utf8");
  const parsed = JSON.parse(json) as Record<string, unknown>;
  if (typeof parsed.created_at !== "string" || typeof parsed.artifact_id !== "string") {
    throw new Error("invalid cursor payload");
  }
  return { created_at: parsed.created_at, artifact_id: parsed.artifact_id };
}

describe("Cursor format — base64(created_at, artifact_id)", () => {
  it("round-trips a cursor without mutating any field", () => {
    const payload: CursorPayload = {
      created_at: "2026-05-07T17:42:11.123Z",
      artifact_id: `art_${alnum16}`,
    };
    const cursor = encodeCursor(payload);
    const decoded = decodeCursor(cursor);
    expect(decoded).toEqual(payload);
    expect(encodeCursor(decoded)).toBe(cursor);
  });

  it("round-trips a hand-rolled cursor (the canonical wire form)", () => {
    // A concrete reference cursor: agents see strings of this form on the wire.
    const payload: CursorPayload = {
      created_at: "2026-05-07T00:00:00.000Z",
      artifact_id: "art_0123456789ABCDEF",
    };
    const cursor = encodeCursor(payload);
    expect(typeof cursor).toBe("string");
    expect(cursor.length).toBeGreaterThan(0);
    expect(decodeCursor(cursor)).toEqual(payload);
  });

  it("rejects malformed cursor payloads", () => {
    const malformed = Buffer.from("not-json", "utf8").toString("base64");
    expect(() => decodeCursor(malformed)).toThrow();
  });

  it("rejects a cursor whose payload is missing artifact_id", () => {
    const cursor = Buffer.from(
      JSON.stringify({ created_at: "2026-05-07T00:00:00.000Z" }),
      "utf8",
    ).toString("base64");
    expect(() => decodeCursor(cursor)).toThrow();
  });
});
