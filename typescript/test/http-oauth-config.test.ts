// AG-07 hardening — resolveOAuthConfig startup guards (findings #2 and #4).
//
// Pure validator extracted from cli.ts so the fail-fast startup behavior is
// unit-testable without spawning the CLI. createRemoteJWKSet does not fetch
// until first verify, so building the verifier here is offline-safe.

import { describe, it, expect } from "vitest";
import { resolveOAuthConfig, type OAuthEnv } from "../src/http/oauth-config.js";

const BASE: OAuthEnv = {
  jwksUrl: "https://ref.supabase.co/auth/v1/.well-known/jwks.json",
  internalApiUrl: "https://internal.railway.internal",
  internalSecret: "secret-xyz",
  clientId: "mcp-client-1",
  publicApiUrl: "https://api.artifacta.io",
  audience: "https://mcp.artifacta.io/mcp",
};

describe("resolveOAuthConfig", () => {
  it("is disabled when no JWKS URL is set (ak_live_-only)", () => {
    const res = resolveOAuthConfig({ ...BASE, jwksUrl: undefined });
    expect(res).toEqual({ enabled: false });
  });

  it("resolves a verifier when fully and safely configured", () => {
    const res = resolveOAuthConfig(BASE);
    expect(res.enabled).toBe(true);
    if (!res.enabled || "errors" in res) throw new Error("expected config");
    expect(res.config.verifier).toBeDefined();
    expect(res.config.internalApiUrl).toBe(BASE.internalApiUrl);
    expect(res.config.internalSecret).toBe(BASE.internalSecret);
  });

  it("errors when the internal API URL is missing", () => {
    const res = resolveOAuthConfig({ ...BASE, internalApiUrl: undefined });
    expect(res).toMatchObject({ enabled: true });
    expect("errors" in res && res.errors.join(" ")).toContain("ARTIFACTA_INTERNAL_API_URL is required");
  });

  it("errors when the internal secret is missing", () => {
    const res = resolveOAuthConfig({ ...BASE, internalSecret: "" });
    expect("errors" in res && res.errors.join(" ")).toContain("MCP_INTERNAL_SECRET is required");
  });

  // Finding #2: OAuth must not be enabled without a bound client.
  it("errors when MCP_OAUTH_CLIENT_ID is missing", () => {
    const res = resolveOAuthConfig({ ...BASE, clientId: undefined });
    expect("errors" in res && res.errors.join(" ")).toContain("MCP_OAUTH_CLIENT_ID is required");
  });

  // Finding #4: the internal origin must differ from the public origin, or the
  // cross-tenant secret would be sent to the public API.
  it("errors when the internal origin equals the public origin", () => {
    const res = resolveOAuthConfig({
      ...BASE,
      internalApiUrl: "https://api.artifacta.io",
      publicApiUrl: "https://api.artifacta.io",
    });
    expect("errors" in res && res.errors.join(" ")).toContain("must differ from the public");
  });

  it("treats a path/port difference on the same origin as a match (still errors)", () => {
    // Same scheme+host+port = same origin even with different paths.
    const res = resolveOAuthConfig({
      ...BASE,
      internalApiUrl: "https://api.artifacta.io/internal",
      publicApiUrl: "https://api.artifacta.io",
    });
    expect("errors" in res && res.errors.join(" ")).toContain("must differ from the public");
  });

  it("allows a distinct internal origin (host or port differs)", () => {
    const res = resolveOAuthConfig({
      ...BASE,
      internalApiUrl: "https://api.artifacta.io:8443",
      publicApiUrl: "https://api.artifacta.io",
    });
    expect(res.enabled && !("errors" in res)).toBe(true);
  });

  it("errors when the internal API URL is malformed", () => {
    const res = resolveOAuthConfig({ ...BASE, internalApiUrl: "not a url" });
    expect("errors" in res && res.errors.join(" ")).toContain("not a valid URL");
  });

  it("collects multiple problems at once", () => {
    const res = resolveOAuthConfig({
      ...BASE,
      internalApiUrl: undefined,
      internalSecret: undefined,
      clientId: undefined,
    });
    if (!("errors" in res)) throw new Error("expected errors");
    expect(res.errors.length).toBeGreaterThanOrEqual(3);
  });
});
