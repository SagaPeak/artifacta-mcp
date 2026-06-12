import { describe, it, expect, beforeEach } from "vitest";
import { translateHttpFailure } from "../src/errors/translate.js";
import { cacheKeySuffix, clearKeySuffixCache } from "../src/whoami-cache.js";
import type { HttpFailure } from "../src/http/types.js";

function makeFailure(
  code: string,
  status: number,
  overrides: Partial<HttpFailure> = {}
): HttpFailure {
  return {
    ok: false,
    status,
    error: {
      code,
      message: `${code} error message`,
      status,
      ...overrides.error,
    },
    attempts: overrides.attempts ?? 1,
    ambiguousCompletion: overrides.ambiguousCompletion,
  };
}

describe("translateHttpFailure — error code taxonomy (§6 verbatim)", () => {
  const cases: Array<{ code: string; status: number; containsPhrase: string }> = [
    { code: "invalid_request", status: 400, containsPhrase: "Bad arguments:" },
    { code: "unauthorized", status: 401, containsPhrase: "Artifacta authentication failed" },
    { code: "quota_exceeded", status: 403, containsPhrase: "Plan quota exceeded:" },
    { code: "ttl_exceeds_plan_limit", status: 400, containsPhrase: "Requested TTL exceeds plan max" },
    { code: "artifact_not_found", status: 404, containsPhrase: "does not exist or is not visible" },
    { code: "session_not_found", status: 404, containsPhrase: "Sessions are synthesized from artifacts" },
    { code: "session_sealed", status: 409, containsPhrase: "is sealed" },
    { code: "artifact_expired", status: 410, containsPhrase: "expired at" },
    { code: "artifact_already_deleted", status: 410, containsPhrase: "was deleted at" },
    { code: "file_too_large", status: 413, containsPhrase: "request_upload_url" },
    { code: "upload_not_found", status: 400, containsPhrase: "have not arrived at R2" },
    { code: "rate_limited", status: 429, containsPhrase: "Rate limit hit" },
  ];

  for (const { code, status, containsPhrase } of cases) {
    it(`${code} (HTTP ${status}) contains correct phrase`, () => {
      const result = translateHttpFailure(makeFailure(code, status));
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(containsPhrase);
    });

    it(`${code}: _meta.code = "${code}"`, () => {
      const result = translateHttpFailure(makeFailure(code, status));
      expect(result._meta.code).toBe(code);
      expect(result._meta.status).toBe(status);
    });
  }
});

describe("translateHttpFailure — extraVars {{id}} fill (AF_MCP-3.3)", () => {
  it("fills {{id}} in upload_not_found when the caller passes { id }", () => {
    const result = translateHttpFailure(
      makeFailure("upload_not_found", 400),
      "complete_upload",
      { id: "art_AAAAAAAAAAAAAAAA" }
    );
    expect(result.content[0].text).toBe(
      "Bytes for artifact art_AAAAAAAAAAAAAAAA have not arrived at R2 yet. PUT to the presigned URL and retry."
    );
  });

  it("fills {{id}} in artifact_not_found when the caller passes { id }", () => {
    const result = translateHttpFailure(
      makeFailure("artifact_not_found", 404),
      "complete_upload",
      { id: "art_BBBBBBBBBBBBBBBB" }
    );
    expect(result.content[0].text).toContain("art_BBBBBBBBBBBBBBBB");
    expect(result.content[0].text).toContain("does not exist or is not visible");
  });

  it("leaves {{id}} empty when no extraVars passed (existing get_artifact behavior)", () => {
    const result = translateHttpFailure(makeFailure("upload_not_found", 400));
    // {{id}} renders empty → no 'art_' token in the rendered summary.
    expect(result.content[0].text).toContain("have not arrived at R2");
    expect(result.content[0].text).not.toContain("art_");
  });
});

describe("_meta block structure", () => {
  it("every result has status, code, retry_hint", () => {
    const codes = [
      "invalid_request", "unauthorized", "quota_exceeded", "artifact_not_found",
      "session_not_found", "session_sealed", "artifact_expired", "artifact_already_deleted",
      "file_too_large", "rate_limited", "upload_not_found", "ttl_exceeds_plan_limit",
    ];
    for (const code of codes) {
      const result = translateHttpFailure(makeFailure(code, 400));
      expect(result._meta).toHaveProperty("status");
      expect(result._meta).toHaveProperty("code");
      expect(result._meta).toHaveProperty("retry_hint");
      expect(["do_not_retry", "retry_after", "retry_with_backoff"]).toContain(
        result._meta.retry_hint
      );
    }
  });

  it("rate_limited: retry_hint = retry_after", () => {
    const result = translateHttpFailure(makeFailure("rate_limited", 429));
    expect(result._meta.retry_hint).toBe("retry_after");
  });

  it("server_error: retry_hint = retry_with_backoff", () => {
    const result = translateHttpFailure(makeFailure("server_error", 502, { attempts: 3 }));
    expect(result._meta.retry_hint).toBe("retry_with_backoff");
  });

  it("quota_exceeded: upgrade_url passed through to _meta", () => {
    const failure: HttpFailure = {
      ok: false,
      status: 403,
      error: {
        code: "quota_exceeded",
        message: "artifact count exceeded",
        status: 403,
        upgrade_url: "https://app.artifacta.io/pricing",
      },
      attempts: 1,
    };
    const result = translateHttpFailure(failure);
    expect(result._meta.upgrade_url).toBe("https://app.artifacta.io/pricing");
  });
});

describe("unauthorized — auth remediation text", () => {
  beforeEach(() => clearKeySuffixCache());

  it("includes ARTIFACTA_API_KEY remediation text", () => {
    const result = translateHttpFailure(makeFailure("unauthorized", 401));
    expect(result.content[0].text).toContain("ARTIFACTA_API_KEY");
    expect(result.content[0].text).toContain("https://app.artifacta.io/dashboard/keys");
  });

  it("includes --api-key flag mention", () => {
    const result = translateHttpFailure(makeFailure("unauthorized", 401));
    expect(result.content[0].text).toContain("--api-key");
  });

  it("includes key suffix from whoami cache when available", () => {
    cacheKeySuffix("cd34");
    const result = translateHttpFailure(makeFailure("unauthorized", 401));
    expect(result.content[0].text).toContain("****cd34");
  });

  it("omits key suffix gracefully when cache is empty", () => {
    const result = translateHttpFailure(makeFailure("unauthorized", 401));
    expect(result.content[0].text).not.toContain("****");
  });
});

describe("tenant suspended path", () => {
  it("returns account-deletion message for suspended unauthorized", () => {
    const failure: HttpFailure = {
      ok: false,
      status: 401,
      error: { code: "unauthorized", message: "Account suspended", status: 401 },
      attempts: 1,
    };
    const result = translateHttpFailure(failure);
    expect(result.content[0].text).toContain("scheduled for deletion");
    expect(result.content[0].text).toContain("https://app.artifacta.io/dashboard/account");
  });
});

describe("ambiguous-completion guidance", () => {
  it("request_upload_url 5xx returns ambiguous guidance", () => {
    const failure: HttpFailure = {
      ok: false,
      status: 502,
      error: { code: "server_error", message: "bad gateway", status: 502 },
      attempts: 1,
      ambiguousCompletion: true,
    };
    const result = translateHttpFailure(failure, "request_upload_url");
    expect(result.content[0].text).toContain("may or may not have created the record");
    expect(result.content[0].text).toContain("request_upload_url");
    expect(result.content[0].text).toContain("Before retrying:");
  });

  it("create_download_link 5xx returns ambiguous guidance", () => {
    const failure: HttpFailure = {
      ok: false,
      status: 503,
      error: { code: "server_error", message: "unavailable", status: 503 },
      attempts: 1,
      ambiguousCompletion: true,
    };
    const result = translateHttpFailure(failure, "create_download_link");
    expect(result.content[0].text).toContain("create_download_link");
    expect(result.content[0].text).toContain("Retrying without checking risks");
  });
});

describe("5xx / network error", () => {
  it("includes retry count in error text", () => {
    const failure: HttpFailure = {
      ok: false,
      status: 503,
      error: { code: "server_error", message: "unavailable", status: 503 },
      attempts: 3,
    };
    const result = translateHttpFailure(failure);
    expect(result.content[0].text).toContain("3");
    expect(result.content[0].text).toContain("status.artifacta.io");
  });

  it("network error (status 0) handled gracefully", () => {
    const failure: HttpFailure = {
      ok: false,
      status: 0,
      error: { code: "network_error", message: "ECONNREFUSED", status: 0 },
      attempts: 1,
    };
    const result = translateHttpFailure(failure);
    expect(result.isError).toBe(true);
    expect(result._meta.retry_hint).toBe("retry_with_backoff");
  });
});

describe("rate_limited: retry_after_seconds in text and _meta", () => {
  it("includes retry_after_seconds in text", () => {
    const failure: HttpFailure = {
      ok: false,
      status: 429,
      error: { code: "rate_limited", message: "slow down", status: 429, retry_after: 30 },
      attempts: 1,
    };
    const result = translateHttpFailure(failure);
    expect(result.content[0].text).toContain("30");
    expect(result._meta.retry_after_seconds).toBe(30);
  });
});

describe("result shape", () => {
  it("every result has isError=true and text content", () => {
    const codes = [
      "invalid_request", "unauthorized", "quota_exceeded", "artifact_not_found",
    ];
    for (const code of codes) {
      const result = translateHttpFailure(makeFailure(code, 400));
      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      expect(typeof result.content[0].text).toBe("string");
      expect(result.content[0].text.length).toBeGreaterThan(0);
    }
  });
});
