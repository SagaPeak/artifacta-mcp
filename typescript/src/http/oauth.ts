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
  /**
   * AG-DCR-02 (Dynamic Client Registration, §3.3 V1). When true, client ids are
   * per-client and unknown ahead of time, so exact-id matching is impossible.
   * Relax `expectedClientId` to "a `client_id`/`azp` claim is PRESENT" and trust
   * `aud` (already enforced to MCP_RESOURCE_URI above): the hook stamps the MCP
   * `aud` ONLY for a grant-backed/fixed client and base GoTrue never sets it on
   * its own (HM-DCR-01 spike), so a signature-valid MCP-aud token can only have
   * come from a hook-recognized client. Default (false) keeps the strict AG-07
   * single-id binding for non-DCR deploys.
   */
  dcrEnabled?: boolean;
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

      // AG-DCR-01 hardening (adversarial review): a token's OAuth client id is
      // derived from two claims, `client_id` and `azp`. In a normal Supabase flow
      // GoTrue sets client_id == azp, so they never disagree. If a token carries
      // BOTH with DIFFERENT values it is AMBIGUOUS: the COALESCE below would bind
      // identity (and the AG-10 revocation key) to `client_id`, while the token
      // hook may have recognized/enriched it on `azp` (e.g. azp == the fixed id) —
      // breaking per-client grant isolation and revocation. Fail closed (401) for
      // the same shape the hook treats as NOT an MCP client. Applies in BOTH DCR
      // and non-DCR modes; the consistency guard is unconditional. Log only the
      // failure class — NEVER claim values.
      if (
        typeof payload.client_id === "string" &&
        typeof payload.azp === "string" &&
        payload.client_id !== payload.azp
      ) {
        logger.warning("oauth token client_id/azp mismatch");
        return null;
      }

      const clientId =
        typeof payload.client_id === "string"
          ? payload.client_id
          : typeof payload.azp === "string"
            ? payload.azp
            : undefined;

      // Client binding (AG-08 follow-up; AG-DCR-02 DCR mode). The Supabase token
      // hook mints the MCP `aud` only for a client it recognizes — for ANY OAuth
      // flow carrying the fixed `client_id` (Phase 2) or, after AG-DCR-01, a client
      // backed by a non-revoked consent grant. Base GoTrue never sets aud=MCP on
      // its own (HM-DCR-01 spike).
      //
      //  - Non-DCR (default): `expectedClientId` is set and exact match is required,
      //    which also rejects a token that omits `client_id` (undefined !== expected).
      //    A token minted by a DIFFERENT OAuth client of the same project that
      //    carried the MCP audience would otherwise be accepted (cross-client
      //    substitution). Production makes this mandatory: `resolveOAuthConfig`
      //    refuses to enable OAuth without `MCP_OAUTH_CLIENT_ID`.
      //  - DCR mode (`dcrEnabled`): client ids are per-client and unknown, so exact
      //    match is impossible. Relax to "client_id/azp PRESENT" — the
      //    cross-client-substitution defense moves to the hook (it stamps aud=MCP
      //    only for a recognized client), and jose already enforced aud above, so a
      //    signature-valid MCP-aud token can only have come from a hook-recognized
      //    client. A token with no client id is not an OAuth-client token → reject.
      if (cfg.dcrEnabled) {
        if (!clientId) {
          logger.warning("oauth token missing client_id claim (DCR mode)");
          return null;
        }
      } else if (
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
  dcrEnabled?: boolean;
}): OAuthVerifier {
  const jwks = createRemoteJWKSet(new URL(opts.jwksUrl));
  return createOAuthVerifier({
    keyInput: jwks,
    audience: opts.audience,
    expectedClientId: opts.expectedClientId,
    dcrEnabled: opts.dcrEnabled,
  });
}
