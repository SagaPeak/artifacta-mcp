// Hosted auth resolver (AG-02 + AG-07).
//
// Resolves an `Authorization: Bearer` header to a principal. An `ak_live_`
// SHAPE match is an API-key principal (full scope, forwarded verbatim to
// api.artifacta.io — no internal headers, no rewriting). Otherwise, when an
// OAuth verifier is configured, the bearer is validated as a Supabase JWT and
// becomes a scope-limited OAuthPrincipal. Both feed the same RequestContext.

import { KEY_REGEX } from "../config.js";
import { FULL_SCOPES, type Principal } from "./request-context.js";
import type { OAuthVerifier } from "./oauth.js";

// `Authorization: Bearer <token>` — scheme is case-insensitive per RFC 6750.
const BEARER_RE = /^Bearer[ \t]+(.+)$/i;

/** Pull the raw token out of an Authorization header, or null if it is absent
 * or not a Bearer credential. */
export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = BEARER_RE.exec(authHeader.trim());
  if (!match) return null;
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

/**
 * Resolve an Authorization header to a principal.
 *
 * Resolution order (hosted-mcp.md): an `ak_live_` *shape* match is always an
 * API-key principal — a JWT is never tried as an `ak_live_` key, and an
 * `ak_live_`-shaped token is never sent through JWT validation. Otherwise, if
 * an `oauthVerifier` is configured, the bearer is validated as a Supabase JWT
 * (returns null on any JWT failure). Returns null when the header is missing,
 * not a Bearer credential, not a well-formed key, or — with no verifier — not
 * an API key; the caller turns null into 401.
 */
export async function resolvePrincipal(
  authHeader: string | undefined,
  oauthVerifier?: OAuthVerifier
): Promise<Principal | null> {
  const token = extractBearerToken(authHeader);
  if (token === null) return null;
  if (KEY_REGEX.test(token)) {
    return { kind: "api_key", token, scopes: FULL_SCOPES };
  }
  if (oauthVerifier) {
    return oauthVerifier.verify(token);
  }
  return null;
}
