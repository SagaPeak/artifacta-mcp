// AF_MCP-7.2.04 + 7.2.23 — Error-code coverage subsuite.
//
// One test block per error code in the §6 / CLAUDE.md taxonomy:
//   invalid_request, unauthorized, quota_exceeded, ttl_exceeds_plan_limit,
//   artifact_not_found, session_not_found, session_sealed, artifact_expired,
//   artifact_already_deleted, file_too_large, rate_limited, upload_not_found
//
// Each block asserts that an HTTP failure carrying the wire code maps through
// `translateHttpFailure()` to the documented agent-readable text from
// `errors/messages.ts`. This is a passthrough contract test: the wire code is
// the contract, the translated text is the contract — neither may drift
// without a deliberate spec change.
//
// Codes that map cleanly via `translateHttpFailure(synthetic-failure, tool)`
// are tested unconditionally with synthetic envelopes (no staging needed).
// Codes that require an actual write tool (`session_sealed`,
// `artifact_already_deleted`, `upload_not_found`) are scaffolded here as
// SKIP-with-future-tool until the corresponding Phase-6 / 8 handler ships.
//
// AF_MCP-7.2.23 — tenant-suspended scenario rides on the `unauthorized` block:
// a synthetic failure with `message` containing "suspended" routes through
// the `TENANT_SUSPENDED_SUMMARY` branch in `translateHttpFailure`.

import { describe, it, expect } from "vitest";
import { translateHttpFailure } from "../../src/errors/translate.js";
import type { HttpFailure } from "../../src/http/types.js";

function makeFailure(
  code: string,
  message: string,
  status: number,
  extra: Partial<HttpFailure["error"]> = {},
  ambiguous = false
): HttpFailure {
  return {
    ok: false,
    status,
    error: {
      code,
      message,
      status,
      ...extra,
    },
    attempts: 1,
    ambiguousCompletion: ambiguous,
  };
}

describe("AF_MCP-7.2.04 — error-code translation per §6 taxonomy", () => {
  it("invalid_request — translated text mirrors the §6 template", () => {
    const out = translateHttpFailure(
      makeFailure("invalid_request", "filename must be set", 400),
      "store_artifact"
    );
    const text = out.content.map((c) => c.text).join("\n");
    expect(text).toContain("Bad arguments: filename must be set");
    expect(out._meta.code).toBe("invalid_request");
    expect(out._meta.retry_hint).toBe("do_not_retry");
  });

  it("unauthorized — translated text uses the §4.3 remediation template", () => {
    const out = translateHttpFailure(
      makeFailure("unauthorized", "missing or invalid bearer token", 401),
      "whoami"
    );
    const text = out.content.map((c) => c.text).join("\n");
    expect(text).toContain("Artifacta authentication failed");
    expect(text).toContain("ARTIFACTA_API_KEY");
    expect(out._meta.code).toBe("unauthorized");
    expect(out._meta.retry_hint).toBe("do_not_retry");
  });

  it("quota_exceeded — translated text includes upgrade_url", () => {
    const out = translateHttpFailure(
      makeFailure("quota_exceeded", "monthly request quota exceeded", 402, {
        upgrade_url: "https://app.artifacta.io/dashboard/billing",
      }),
      "list_artifacts"
    );
    const text = out.content.map((c) => c.text).join("\n");
    expect(text).toContain("Plan quota exceeded");
    expect(text).toContain("https://app.artifacta.io/dashboard/billing");
    expect(out._meta.upgrade_url).toBe("https://app.artifacta.io/dashboard/billing");
  });

  it("ttl_exceeds_plan_limit — translated text mentions reduce TTL or upgrade", () => {
    const out = translateHttpFailure(
      makeFailure("ttl_exceeds_plan_limit", "TTL 60d > Free max 7d", 400, {
        upgrade_url: "https://app.artifacta.io/dashboard/billing",
      }),
      "create_download_link"
    );
    const text = out.content.map((c) => c.text).join("\n");
    expect(text).toContain("Requested TTL exceeds plan max");
    expect(text).toContain("Reduce TTL");
  });

  it("artifact_not_found — translated text names the artifact id", () => {
    const out = translateHttpFailure(
      makeFailure("artifact_not_found", "Artifact art_xxxxxxxxxxxxxxxx does not exist", 404),
      "get_artifact"
    );
    const text = out.content.map((c) => c.text).join("\n");
    expect(text).toContain("not exist");
    expect(out._meta.code).toBe("artifact_not_found");
  });

  it("session_not_found — translated text steers to create-first guidance", () => {
    const out = translateHttpFailure(
      makeFailure("session_not_found", "session has no artifacts", 404),
      "list_sessions"
    );
    const text = out.content.map((c) => c.text).join("\n");
    expect(text).toContain("Sessions are synthesized from artifacts");
  });

  it("session_sealed — translated text steers to a different session [future-tool: store_artifact]", () => {
    // Wire code is shipped; tool layer that emits it is Phase 6a.
    const out = translateHttpFailure(
      makeFailure("session_sealed", "Session sealed_run is sealed", 409),
      "store_artifact"
    );
    const text = out.content.map((c) => c.text).join("\n");
    expect(text).toContain("is sealed");
    expect(text).toContain("Use a different session_id");
  });

  it("artifact_expired — translated text mentions re-upload", () => {
    const out = translateHttpFailure(
      makeFailure("artifact_expired", "Artifact art_xx expired at 2026-01-01", 410),
      "get_artifact"
    );
    const text = out.content.map((c) => c.text).join("\n");
    expect(text).toContain("expired");
    expect(text).toContain("Re-upload");
  });

  it("artifact_already_deleted — translated text mentions deletion timestamp [future-tool: delete_artifact]", () => {
    // Wire code is shipped; emitting tool (`delete_artifact`) is Phase 8.
    const out = translateHttpFailure(
      makeFailure(
        "artifact_already_deleted",
        "Artifact art_xx was deleted at 2026-04-01T00:00:00Z",
        410
      ),
      "delete_artifact"
    );
    const text = out.content.map((c) => c.text).join("\n");
    expect(text).toContain("was deleted");
  });

  it("file_too_large — translated text mentions request_upload_url for >500 MB Pro [future-tool: store_artifact]", () => {
    const out = translateHttpFailure(
      makeFailure("file_too_large", "file exceeds path-upload limit", 413),
      "store_artifact"
    );
    const text = out.content.map((c) => c.text).join("\n");
    expect(text).toContain("request_upload_url");
    expect(text).toContain("500 MB");
  });

  it("rate_limited — translated text carries retry_after_seconds and retry_hint=retry_after", () => {
    const out = translateHttpFailure(
      makeFailure("rate_limited", "rate limit reached", 429, { retry_after: 12 }),
      "list_artifacts"
    );
    const text = out.content.map((c) => c.text).join("\n");
    expect(text).toContain("Rate limit hit");
    expect(out._meta.retry_hint).toBe("retry_after");
    expect(out._meta.retry_after_seconds).toBe(12);
  });

  it("upload_not_found — translated text steers to PUT-then-retry [future-tool: complete_upload]", () => {
    const out = translateHttpFailure(
      makeFailure("upload_not_found", "bytes not yet at R2", 409),
      "complete_upload"
    );
    const text = out.content.map((c) => c.text).join("\n");
    expect(text).toContain("Bytes for artifact");
    expect(text).toContain("PUT to the presigned URL");
  });
});

describe("AF_MCP-7.2.23 — tenant-suspended scenario", () => {
  it("unauthorized + 'suspended' message routes to TENANT_SUSPENDED_SUMMARY", () => {
    const out = translateHttpFailure(
      makeFailure(
        "unauthorized",
        "Tenant is suspended (deletion grace period)",
        401
      ),
      "whoami"
    );
    const text = out.content.map((c) => c.text).join("\n");
    expect(text).toContain("Account is scheduled for deletion");
    expect(text).toContain("https://app.artifacta.io/dashboard/account");
    expect(out._meta.retry_hint).toBe("do_not_retry");
  });
});
