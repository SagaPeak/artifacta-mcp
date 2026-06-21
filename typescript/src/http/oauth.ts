// OAuth JWT validation for the hosted MCP server (AG-07).
//
// Validates Supabase-minted OAuth access tokens (ES256, per HM-03) presented as
// `Authorization: Bearer <jwt>` at POST /mcp. Checks, in jose:
//   - signature against the Supabase JWKS,
//   - `exp` (expiry),
//   - `aud` == MCP_RESOURCE_URI (the canonical resource id),
// then extracts `tenant_id` and the granted `scope`. On success it returns an
// OAuthPrincipal; on ANY failure (bad signature, wrong audience, expired,
// garbage, missing tenant, revoked) it resolves to `null` so the transport
// answers 401 — never 500, never a fall-through to the `ak_live_` path, and the
// JWT is never forwarded upstream.
//
// The key source is INJECTABLE (`keyInput`: a jose key or a JWTVerifyGetKey) so
// the unit suite can verify against a locally-minted ES256 key with no network
// (the unit suite mandates offline + low timeouts). Production wiring builds a
// cached `createRemoteJWKSet` over SUPABASE_JWKS_URL — see
// {@link createRemoteOAuthVerifier}.
//
// OPEN_QUESTION #1 (Supabase OAuth fit / AG-08 follow-up): the live Supabase
// access-token claim shape for `scope` and `client_id` is not yet verified
// against a real minted token (deferred to the OAuth canary). This validator is
// therefore defensive: an absent/garbage `scope` claim yields an empty grant
// (auth ok, zero tools) rather than a hard failure, and `client_id` narrowing
// is opt-in via `expectedClientId` (unset until DCR/registration pins the MCP
// client id — `aud` is the sole audience gate until then).

import { jwtVerify, createRemoteJWKSet, type JWTPayload } from "jose";
import type { OAuthPrincipal } from "./request-context.js";
import { parseGrantedScopes } from "../safety/scopes.js";
import { isRevoked } from "./revocation.js";
import { logger } from "../log/logger.js";

/** jose accepts a key OR a getKey function as the second `jwtVerify` argument. */
type KeyInput = Parameters<typeof jwtVerify>[1];

export interface OAuthVerifierConfig {
  /** A jose key (unit tests) or JWKS resolver (production createRemoteJWKSet). */
  keyInput: KeyInput;
  /** Required `aud` — the canonical MCP resource URI (MCP_RESOURCE_URI). */
  audience: string;
  /** When set, the token's `client_id` (or `azp`) must equal this — the AG-08
   * follow-up to narrow the MCP audience to a known client. Unset = `aud` only. */
  expectedClientId?: string;
}

export interface OAuthVerifier {
  /** Validate a bearer JWT. Returns a principal, or `null` on ANY failure. */
  verify(token: string): Promise<OAuthPrincipal | null>;
}

export function createOAuthVerifier(cfg: OAuthVerifierConfig): OAuthVerifier {
  return {
    async verify(token: string): Promise<OAuthPrincipal | null> {
      let payload: JWTPayload;
      try {
        // `algorithms: ["ES256"]` pins the signature alg (HM-03), closing the
        // alg-confusion door (a token claiming alg:none / HS256 is rejected).
        // `audience` enforces aud == MCP_RESOURCE_URI.
        //
        // `requiredClaims: ["exp", "iat"]` is load-bearing: jose only *validates*
        // `exp` when it is present, so without this a token that OMITS `exp`
        // would validate forever (fail-open — a stolen/leaked token never
        // expires). `iat` is required too because revocation (AG-10) keys on it,
        // and a token with no `iat` could otherwise dodge a revocation cutoff.
        const result = await jwtVerify(token, cfg.keyInput, {
          audience: cfg.audience,
          algorithms: ["ES256"],
          requiredClaims: ["exp", "iat"],
        });
        payload = result.payload;
      } catch (err) {
        // Bad signature / wrong aud / expired / garbage — all 401. Log only the
        // failure class (jose error name); NEVER the token.
        logger.warning("oauth token rejected", {
          reason: err instanceof Error ? err.name : "unknown",
        });
        return null;
      }

      const tenantId =
        typeof payload.tenant_id === "string" ? payload.tenant_id : undefined;
      if (!tenantId) {
        // A validly-signed token with no tenant cannot be routed to a tenant —
        // fail closed (401), distinct from the empty-scope case (auth ok).
        logger.warning("oauth token missing tenant_id claim");
        return null;
      }

      const clientId =
        typeof payload.client_id === "string"
          ? payload.client_id
          : typeof payload.azp === "string"
            ? payload.azp
            : undefined;

      // Client binding (AG-08 follow-up). The Supabase token hook mints the MCP
      // `aud` for ANY OAuth flow that carries a `client_id`, so `aud` alone does
      // NOT prove the token came from the registered MCP client — a token from a
      // different OAuth client of the same Supabase project would otherwise be
      // accepted with its scopes (cross-client substitution). When
      // `expectedClientId` is set we require an exact match, which also rejects a
      // token that omits `client_id` (undefined !== expected). Production makes
      // this mandatory: `resolveOAuthConfig` (oauth-config.ts) refuses to enable
      // OAuth without `MCP_OAUTH_CLIENT_ID`. It stays optional on the injectable
      // verifier only so unit tests can exercise the JWT mechanics in isolation.
      if (
        cfg.expectedClientId !== undefined &&
        clientId !== cfg.expectedClientId
      ) {
        logger.warning("oauth token client_id mismatch");
        return null;
      }

      // AG-10: a revoked (client_id, tenant_id) pair invalidates tokens issued
      // before the revocation cutoff; newer tokens still pass. Depends on the
      // same `client_id` + `iat` claims the OAuth canary must confirm (AG-08).
      if (clientId !== undefined && isRevoked(clientId, tenantId, payload.iat)) {
        logger.warning("oauth token revoked", { reason: "connection_revoked" });
        return null;
      }

      const scopes = parseGrantedScopes(payload.scope ?? payload.scopes);

      return { kind: "oauth", tenantId, scopes, clientId };
    },
  };
}

/**
 * Production verifier: validates against a cached JWKS fetched from `jwksUrl`
 * (Supabase `/auth/v1/.well-known/jwks.json`). The remote set caches keys and
 * internally rate-limits refetches, so this is built once per process.
 */
export function createRemoteOAuthVerifier(opts: {
  jwksUrl: string;
  audience: string;
  expectedClientId?: string;
}): OAuthVerifier {
  const jwks = createRemoteJWKSet(new URL(opts.jwksUrl));
  return createOAuthVerifier({
    keyInput: jwks,
    audience: opts.audience,
    expectedClientId: opts.expectedClientId,
  });
}
