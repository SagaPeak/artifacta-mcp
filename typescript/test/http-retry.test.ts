import { describe, it, expect } from "vitest";
import {
  shouldRetry5xx,
  retryAfterMs,
  JITTER_BASE_MS,
  JITTER_CAP_MS,
  MAX_RETRIES_5XX,
} from "../src/http/retry.js";
import type { RetryPolicy } from "../src/http/types.js";

describe("shouldRetry5xx", () => {
  const retryablePolicies: RetryPolicy[] = ["read", "idempotentWrite"];
  const nonRetryable: RetryPolicy = "nonIdempotentWrite";

  it.each(retryablePolicies)(
    "policy=%s allows retry up to MAX_RETRIES_5XX attempts",
    (policy) => {
      for (let attempt = 0; attempt < MAX_RETRIES_5XX; attempt++) {
        expect(shouldRetry5xx({ attempt, policy })).toBe(true);
      }
      // At MAX_RETRIES_5XX, no more retries
      expect(shouldRetry5xx({ attempt: MAX_RETRIES_5XX, policy })).toBe(false);
    }
  );

  it("nonIdempotentWrite never retries on 5xx", () => {
    for (let attempt = 0; attempt <= MAX_RETRIES_5XX + 1; attempt++) {
      expect(shouldRetry5xx({ attempt, policy: nonRetryable })).toBe(false);
    }
  });

  it("read allows exactly 3 retries (attempts 0, 1, 2)", () => {
    expect(shouldRetry5xx({ attempt: 0, policy: "read" })).toBe(true);
    expect(shouldRetry5xx({ attempt: 1, policy: "read" })).toBe(true);
    expect(shouldRetry5xx({ attempt: 2, policy: "read" })).toBe(true);
    expect(shouldRetry5xx({ attempt: 3, policy: "read" })).toBe(false);
  });
});

describe("retryAfterMs", () => {
  it("returns 1000ms floor when no header or body", () => {
    expect(retryAfterMs(null, undefined)).toBe(1000);
  });

  it("parses Retry-After header in seconds", () => {
    expect(retryAfterMs("5", undefined)).toBe(5000);
    expect(retryAfterMs("0.5", undefined)).toBe(1000); // floor applies
  });

  it("uses body retry_after_seconds when no header", () => {
    expect(retryAfterMs(null, 10)).toBe(10_000);
  });

  it("Retry-After header takes precedence over body", () => {
    expect(retryAfterMs("3", 10)).toBe(3000);
  });

  it("applies 1000ms floor even if header says 0", () => {
    expect(retryAfterMs("0", undefined)).toBe(1000);
  });

  it("ignores non-numeric Retry-After header and uses body", () => {
    // NaN from parseFloat("invalid")
    expect(retryAfterMs("invalid", 5)).toBe(5000);
  });
});

describe("Retry policy table — coverage per §6.1", () => {
  // This test documents the expected per-tool retry classification used by the HTTP client.
  // It does not execute HTTP calls — it validates the policy constants are correct.

  const expectations: Array<{
    tool: string;
    path: string;
    method: string;
    policy: RetryPolicy;
    retries5xx: boolean;
  }> = [
    // Read tools
    { tool: "whoami", path: "/v1/whoami", method: "GET", policy: "read", retries5xx: true },
    { tool: "list_artifacts", path: "/v1/artifacts", method: "GET", policy: "read", retries5xx: true },
    { tool: "get_artifact", path: "/v1/artifacts/:id", method: "GET", policy: "read", retries5xx: true },
    { tool: "get_artifact_download_url", path: "/v1/artifacts/:id/download-url", method: "GET", policy: "read", retries5xx: true },
    { tool: "list_sessions", path: "/v1/sessions", method: "GET", policy: "read", retries5xx: true },
    // Idempotent writes
    { tool: "store_artifact", path: "/v1/artifacts", method: "POST", policy: "idempotentWrite", retries5xx: true },
    { tool: "complete_upload", path: "/v1/artifacts/:id/complete", method: "POST", policy: "idempotentWrite", retries5xx: true },
    { tool: "seal_session", path: "/v1/sessions/:id/seal", method: "POST", policy: "idempotentWrite", retries5xx: true },
    { tool: "delete_artifact", path: "/v1/artifacts/:id", method: "DELETE", policy: "idempotentWrite", retries5xx: true },
    // Non-idempotent writes — no 5xx retry
    { tool: "request_upload_url", path: "/v1/artifacts/upload-url", method: "POST", policy: "nonIdempotentWrite", retries5xx: false },
    { tool: "create_download_link", path: "/v1/artifacts/:id/links", method: "POST", policy: "nonIdempotentWrite", retries5xx: false },
  ];

  for (const { tool, policy, retries5xx } of expectations) {
    it(`${tool}: policy=${policy}, retries5xx=${retries5xx}`, () => {
      expect(shouldRetry5xx({ attempt: 0, policy })).toBe(retries5xx);
    });
  }
});

describe("JITTER constants", () => {
  it("base is 50ms and cap is 500ms", () => {
    expect(JITTER_BASE_MS).toBe(50);
    expect(JITTER_CAP_MS).toBe(500);
  });
});
