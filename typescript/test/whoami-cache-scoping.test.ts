// AG-03 hardening — the whoami key-suffix cache must be request-scoped over
// hosted HTTP so one tenant's key suffix can never surface in another tenant's
// auth-error remediation text. Stdio (no request context) keeps the module global.

import { describe, it, expect, afterEach } from "vitest";
import {
  cacheKeySuffix,
  getCachedKeySuffix,
  clearKeySuffixCache,
} from "../src/whoami-cache.js";
import { runWithRequestContext } from "../src/http/request-context.js";
import { ArtifactaHttpClient } from "../src/http/client.js";

function ctx(token: string) {
  return {
    principal: { kind: "api_key" as const, token, scopes: [] as string[] },
    httpClient: new ArtifactaHttpClient({ apiKey: token, apiUrl: "https://api.artifacta.io" }),
  };
}

afterEach(() => clearKeySuffixCache());

describe("whoami key-suffix cache scoping", () => {
  it("isolates the suffix per request context and never writes the global", () => {
    cacheKeySuffix("base"); // stdio path → module global

    const aSuffix = runWithRequestContext(ctx("ak_live_" + "a".repeat(32)), () => {
      cacheKeySuffix("aaaa");
      return getCachedKeySuffix();
    });
    const bSuffix = runWithRequestContext(ctx("ak_live_" + "b".repeat(32)), () => {
      cacheKeySuffix("bbbb");
      return getCachedKeySuffix();
    });

    expect(aSuffix).toBe("aaaa");
    expect(bSuffix).toBe("bbbb");
    // The per-request writes must not have leaked into the module global.
    expect(getCachedKeySuffix()).toBe("base");
  });

  it("reads undefined in a fresh context that has not cached a suffix", () => {
    cacheKeySuffix("base");
    const seen = runWithRequestContext(ctx("ak_live_" + "c".repeat(32)), () =>
      getCachedKeySuffix()
    );
    expect(seen).toBeUndefined();
  });
});
