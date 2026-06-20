// Phase 0 hosted auth resolver (AG-02).
//
// Accepts a raw `ak_live_` bearer over HTTP and turns it into a full-scope
// API-key principal. The key is forwarded to api.artifacta.io exactly as the
// stdio path forwards it — no internal service headers, no token rewriting.
//
// OAuth (AG-07) will add a second resolver that validates a Supabase JWT and
// produces a scope-limited principal; both feed the same RequestContext.

import { KEY_REGEX } from "../config.js";
import { FULL_SCOPES, type Principal } from "./request-context.js";

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

/** Resolve an Authorization header to a principal. Returns null when the header
 * is missing, not a Bearer credential, or not a well-formed `ak_live_` key —
 * the caller turns null into 401. */
export function resolvePrincipal(authHeader: string | undefined): Principal | null {
  const token = extractBearerToken(authHeader);
  if (token === null) return null;
  if (!KEY_REGEX.test(token)) return null;
  return { kind: "api_key", token, scopes: FULL_SCOPES };
}
