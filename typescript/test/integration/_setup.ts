// Shared helpers for the AF_MCP-7.2 integration suite (plan §9.2).
//
// The suite runs nightly against a sandbox staging tenant
// (`ARTIFACTA_STAGING_KEY` set) AND on PR builds without staging — most
// staging-bound cases skip cleanly. SKIP reasons distinguish:
//   - [needs-staging]   — requires live API + sandbox tenant
//   - [future-tool: X]  — needs MCP tool X (lands in a later phase)
//   - [needs-fixture: Y] — requires a specific data fixture on staging

export const STAGING_KEY: string | undefined = process.env.ARTIFACTA_STAGING_KEY;
export const STAGING_API_URL: string =
  process.env.ARTIFACTA_STAGING_API_URL ?? "https://api.artifacta.io";

// Optional second key for the cross-tenant isolation test fixture.
export const STAGING_KEY_TENANT_B: string | undefined =
  process.env.ARTIFACTA_STAGING_KEY_TENANT_B;

// Optional Pro-tier key for the size-cap-on-Pro fixture.
export const STAGING_PRO_KEY: string | undefined = process.env.ARTIFACTA_STAGING_PRO_KEY;

// Optional tenant-suspended fixture key (deletion grace period).
export const STAGING_SUSPENDED_KEY: string | undefined =
  process.env.ARTIFACTA_STAGING_SUSPENDED_KEY;

export function hasStaging(): boolean {
  return typeof STAGING_KEY === "string" && STAGING_KEY.length > 0;
}

// Plan §7 Phase 1 ships stdio only; Phase 4 adds SSE. The integration
// scaffolding is parameterized by transport so when SSE lands the same
// suites re-run by overriding `ARTIFACTA_MCP_INTEGRATION_TRANSPORTS=sse`.
export type Transport = "stdio" | "sse";
export const DEFAULT_TRANSPORTS: readonly Transport[] = ["stdio"];

export const TRANSPORTS: readonly Transport[] = ((): readonly Transport[] => {
  const env = process.env.ARTIFACTA_MCP_INTEGRATION_TRANSPORTS;
  if (!env) return DEFAULT_TRANSPORTS;
  const parsed = env
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as Transport[];
  return parsed.length === 0 ? DEFAULT_TRANSPORTS : parsed;
})();
