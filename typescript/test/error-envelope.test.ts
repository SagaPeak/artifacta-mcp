// AF_MCP-7.1 — Unit suite: error-envelope round-trip per plan §9.1.
//
// For every error code in the closed taxonomy from CLAUDE.md, build a
// synthetic HttpFailure, run it through `translateHttpFailure()`, and assert
// the resulting MCP error result is valid against the published MCP error
// schema (`CallToolResultSchema` from the official SDK — *not* a hand-rolled
// copy, per AC).
//
// The CLAUDE.md taxonomy is the contract. If a code is added or renamed,
// both the error translator AND this suite must update — the missing-key
// assertion below catches drift between the two.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { translateHttpFailure } from "../src/errors/translate.js";
import { AGENT_SUMMARIES } from "../src/errors/messages.js";
import { cacheKeySuffix, clearKeySuffixCache } from "../src/whoami-cache.js";
import type { HttpFailure } from "../src/http/types.js";

// ─── Closed taxonomy from CLAUDE.md ──────────────────────────────────────────
// One row per error code. `status` and `extras` reflect realistic API
// responses for that code; `expectedRetryHint` is the hint the MCP server
// surfaces in `_meta.retry_hint`.

interface TaxonomyRow {
  code: string;
  status: number;
  message: string;
  extras?: Partial<HttpFailure["error"]>;
  ambiguousCompletion?: boolean;
  expectedRetryHint:
    | "do_not_retry"
    | "retry_after"
    | "retry_with_backoff";
}

const TAXONOMY: TaxonomyRow[] = [
  { code: "invalid_request", status: 400, message: "metadata key 'foo.bar' rejected", expectedRetryHint: "do_not_retry" },
  { code: "unauthorized", status: 401, message: "missing API key", expectedRetryHint: "do_not_retry" },
  { code: "quota_exceeded", status: 402, message: "monthly artifacts: 100/100", extras: { upgrade_url: "https://app.artifacta.io/dashboard/billing" }, expectedRetryHint: "do_not_retry" },
  { code: "ttl_exceeds_plan_limit", status: 400, message: "ttl 30d exceeds free plan max 7d", extras: { upgrade_url: "https://app.artifacta.io/dashboard/billing" }, expectedRetryHint: "do_not_retry" },
  { code: "artifact_not_found", status: 404, message: "art_AAAAAAAAAAAAAAAA not found", expectedRetryHint: "do_not_retry" },
  { code: "session_not_found", status: 404, message: "session 'sess-xyz' not found", expectedRetryHint: "do_not_retry" },
  { code: "session_sealed", status: 409, message: "session is sealed", expectedRetryHint: "do_not_retry" },
  { code: "artifact_expired", status: 410, message: "artifact expired", expectedRetryHint: "do_not_retry" },
  { code: "artifact_already_deleted", status: 410, message: "artifact deleted", expectedRetryHint: "do_not_retry" },
  { code: "file_too_large", status: 413, message: "size 750000000 exceeds 500 MB", expectedRetryHint: "do_not_retry" },
  { code: "upload_not_found", status: 409, message: "bytes not yet at R2", expectedRetryHint: "do_not_retry" },
  { code: "rate_limited", status: 429, message: "60/min hit", extras: { retry_after: 12 }, expectedRetryHint: "retry_after" },
];

const CODES_IN_TAXONOMY = new Set(TAXONOMY.map((r) => r.code));

function makeFailure(row: TaxonomyRow): HttpFailure {
  return {
    ok: false,
    status: row.status,
    error: {
      code: row.code,
      status: row.status,
      message: row.message,
      ...(row.extras ?? {}),
    },
    attempts: 1,
    ambiguousCompletion: row.ambiguousCompletion,
  };
}

// ─── Coverage gates ──────────────────────────────────────────────────────────

describe("Error envelope — taxonomy coverage", () => {
  it("covers every code defined in AGENT_SUMMARIES", () => {
    const summaryCodes = new Set(Object.keys(AGENT_SUMMARIES));
    const missing = [...summaryCodes].filter((c) => !CODES_IN_TAXONOMY.has(c));
    expect(missing).toEqual([]);
  });

  it("has exactly 12 codes (CLAUDE.md taxonomy length)", () => {
    expect(TAXONOMY.length).toBe(12);
  });
});

// ─── Per-code round-trip ─────────────────────────────────────────────────────

describe("Error envelope — round-trip per error code", () => {
  beforeEach(() => clearKeySuffixCache());
  afterEach(() => clearKeySuffixCache());

  for (const row of TAXONOMY) {
    it(`${row.code} → MCP error result valid against CallToolResultSchema`, () => {
      const failure = makeFailure(row);
      const result = translateHttpFailure(failure, "fixture_tool");

      // Structural invariants asserted by the MCP error contract.
      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect(typeof result.content[0].text).toBe("string");
      expect(result.content[0].text.length).toBeGreaterThan(0);
      expect(result._meta.code).toBe(row.code);
      expect(result._meta.status).toBe(row.status);
      expect(result._meta.retry_hint).toBe(row.expectedRetryHint);

      if (row.code === "rate_limited") {
        expect(result._meta.retry_after_seconds).toBe(row.extras?.retry_after);
      }

      // Validate against the published MCP error schema (Zod, from the SDK).
      const parsed = CallToolResultSchema.safeParse(result);
      if (!parsed.success) {
        // Surface Zod's diagnostic instead of a bare boolean for fast triage.
        throw new Error(
          `CallToolResultSchema rejected the ${row.code} envelope: ${JSON.stringify(parsed.error.issues, null, 2)}`,
        );
      }
      expect(parsed.success).toBe(true);
    });
  }
});

// ─── Special envelopes (not tied to one taxonomy code) ───────────────────────

describe("Error envelope — special-case branches", () => {
  beforeEach(() => clearKeySuffixCache());
  afterEach(() => clearKeySuffixCache());

  it("ambiguous-completion guidance round-trips for non-idempotent writes", () => {
    const failure: HttpFailure = {
      ok: false,
      status: 502,
      error: { code: "server_error", status: 502, message: "upstream timeout" },
      attempts: 1,
      ambiguousCompletion: true,
    };
    const result = translateHttpFailure(failure, "request_upload_url");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("request_upload_url");
    expect(result._meta.retry_hint).toBe("do_not_retry");
    expect(CallToolResultSchema.safeParse(result).success).toBe(true);
  });

  it("auth-failure remediation includes setup link", () => {
    const failure: HttpFailure = {
      ok: false,
      status: 401,
      error: { code: "unauthorized", status: 401, message: "key revoked" },
      attempts: 1,
    };
    const result = translateHttpFailure(failure, "whoami");
    expect(result.content[0].text).toContain("https://app.artifacta.io/dashboard/keys");
    expect(CallToolResultSchema.safeParse(result).success).toBe(true);
  });

  it("auth-failure includes cached key suffix when present", () => {
    cacheKeySuffix("9XYZ");
    const failure: HttpFailure = {
      ok: false,
      status: 401,
      error: { code: "unauthorized", status: 401, message: "expired" },
      attempts: 1,
    };
    const result = translateHttpFailure(failure, "whoami");
    expect(result.content[0].text).toContain("****9XYZ");
  });

  it("tenant-suspended envelope routes to the account page", () => {
    const failure: HttpFailure = {
      ok: false,
      status: 401,
      error: { code: "unauthorized", status: 401, message: "Tenant SUSPENDED" },
      attempts: 1,
    };
    const result = translateHttpFailure(failure, "whoami");
    expect(result.content[0].text).toContain("/dashboard/account");
    expect(CallToolResultSchema.safeParse(result).success).toBe(true);
  });

  it("5xx server error includes retry count", () => {
    const failure: HttpFailure = {
      ok: false,
      status: 503,
      error: { code: "server_error", status: 503, message: "unavailable" },
      attempts: 3,
    };
    const result = translateHttpFailure(failure);
    expect(result.content[0].text).toContain("503");
    expect(result.content[0].text).toContain("3 times");
    expect(result._meta.retry_hint).toBe("retry_with_backoff");
    expect(CallToolResultSchema.safeParse(result).success).toBe(true);
  });
});
