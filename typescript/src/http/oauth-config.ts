// OAuth startup configuration resolution + validation (AG-07 hardening).
//
// Extracted from cli.ts so the startup guards are unit-testable without spawning
// a process. Pure: no I/O and no `process.exit` — `createRemoteJWKSet` does not
// fetch until the first verify, so building the verifier here is side-effect
// free. The caller (cli.ts) turns an `errors` result into a fatal exit.
//
// Two security invariants are enforced here, both flagged by adversarial review:
//   - OAuth requires a bound client (`MCP_OAUTH_CLIENT_ID`). Without it, a token
//     minted by ANY OAuth client of the same Supabase project that carries the
//     MCP audience would be accepted. `aud` alone is not proof of origin.
//   - The internal API origin MUST differ from the public API origin. If they
//     match, OAuth calls would send the cross-tenant `MCP_INTERNAL_SECRET` to
//     the public origin — crossing the trust boundary the whole design forbids.

import { createRemoteOAuthVerifier, type OAuthVerifier } from "./oauth.js";

export interface OAuthEnv {
  /** `SUPABASE_JWKS_URL`. Absent/empty → OAuth disabled (ak_live_ only). */
  jwksUrl?: string;
  /** `ARTIFACTA_INTERNAL_API_URL` — private internal API for OAuth-backed calls. */
  internalApiUrl?: string;
  /** `MCP_INTERNAL_SECRET` — shared with the internal API service. */
  internalSecret?: string;
  /** `MCP_OAUTH_CLIENT_ID` — the registered MCP OAuth client to bind tokens to. */
  clientId?: string;
  /** The public API base URL (`ARTIFACTA_API_URL`/default) — origin must differ. */
  publicApiUrl: string;
  /** OAuth audience (the canonical MCP resource URI). */
  audience: string;
  /**
   * `MCP_OAUTH_DCR_ENABLED` (AG-DCR-02). When true, dynamically-registered clients
   * are accepted: the verifier relaxes from exact `clientId` binding to "client_id
   * present + aud == MCP_RESOURCE_URI" (§3.3 V1). `MCP_OAUTH_CLIENT_ID` REMAINS
   * required at startup even in DCR mode — DCR relaxes ONLY the verifier's exact-match
   * (the env-presence check is unconditional). The fixed client always stays configured:
   * it serves the hook's fixed-client OR-branch (parallel support, §5) and is the
   * rollback target — unsetting `MCP_OAUTH_DCR_ENABLED` reverts to strict single-id
   * binding, which needs `MCP_OAUTH_CLIENT_ID` present, so keeping it set is what makes
   * the rollback instant (no startup failure / MCP outage). Default (false) keeps the
   * strict AG-07 single-id binding.
   */
  dcrEnabled?: boolean;
}

export interface ResolvedOAuth {
  verifier: OAuthVerifier;
  internalApiUrl: string;
  internalSecret: string;
}

export type OAuthResolution =
  | { enabled: false }
  | { enabled: true; config: ResolvedOAuth }
  | { enabled: true; errors: string[] };

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * Resolve OAuth config from env-like inputs. Returns:
 *  - `{ enabled: false }` when no JWKS URL is set (run ak_live_-only);
 *  - `{ enabled: true, errors }` when JWKS is set but the rest is missing or
 *    unsafe (the caller fails startup);
 *  - `{ enabled: true, config }` when fully and safely configured.
 */
export function resolveOAuthConfig(env: OAuthEnv): OAuthResolution {
  const jwksUrl = env.jwksUrl?.trim();
  if (!jwksUrl) return { enabled: false };

  const internalApiUrl = env.internalApiUrl?.trim() || undefined;
  const internalSecret = env.internalSecret?.trim() || undefined;
  const clientId = env.clientId?.trim() || undefined;
  const dcrEnabled = env.dcrEnabled === true;

  const errors: string[] = [];
  if (!internalApiUrl) {
    errors.push(
      "ARTIFACTA_INTERNAL_API_URL is required — OAuth calls go through the private internal API (the Supabase JWT is never forwarded to the public API)"
    );
  }
  if (!internalSecret) {
    errors.push(
      "MCP_INTERNAL_SECRET is required — shared with the internal API service"
    );
  }
  // MCP_OAUTH_CLIENT_ID is ALWAYS required when OAuth is enabled — including DCR mode.
  // It binds tokens to the registered MCP OAuth client (non-DCR), serves the hook's
  // fixed-client OR-branch (parallel support during the DCR transition, §5), and is the
  // rollback target: unsetting MCP_OAUTH_DCR_ENABLED reverts to strict single-id binding,
  // which requires this value present, so keeping it set is what makes rollback instant
  // (no startup failure). DCR relaxation belongs ONLY in the verifier (it ignores
  // expectedClientId when dcrEnabled) — NOT here. So the presence check is unconditional.
  if (!clientId) {
    errors.push(
      "MCP_OAUTH_CLIENT_ID is required — binds tokens to the registered MCP OAuth client; without it a token minted by ANY OAuth client of the same Supabase project that carries the MCP audience would be accepted. It stays required in DCR mode too (MCP_OAUTH_DCR_ENABLED): the fixed client serves the hook fixed-client fallback and is the instant-rollback target — unsetting the DCR flag reverts to strict binding, which needs this value present"
    );
  }
  if (internalApiUrl) {
    const internalOrigin = originOf(internalApiUrl);
    if (internalOrigin === null) {
      errors.push(`ARTIFACTA_INTERNAL_API_URL is not a valid URL: ${internalApiUrl}`);
    } else if (internalOrigin === originOf(env.publicApiUrl)) {
      errors.push(
        `ARTIFACTA_INTERNAL_API_URL origin (${internalOrigin}) must differ from the public ARTIFACTA_API_URL origin — otherwise MCP_INTERNAL_SECRET would be sent to the public API`
      );
    }
  }

  if (errors.length > 0) return { enabled: true, errors };

  const verifier = createRemoteOAuthVerifier({
    jwksUrl,
    audience: env.audience,
    expectedClientId: clientId,
    dcrEnabled,
  });
  return {
    enabled: true,
    // internalApiUrl / internalSecret are non-undefined here (errors would have
    // been pushed otherwise), but assert for the type narrowing.
    config: { verifier, internalApiUrl: internalApiUrl!, internalSecret: internalSecret! },
  };
}
