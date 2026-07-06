// Supabase Auth is the OAuth 2.1 Authorization Server (HM-02). Trailing-slash-
// free, matching the discovery base the spec advertises. Product default is the
// vanity URL. SUPABASE_JWKS_URL may still point at the project-ref host for JWT
// validation — PRM branding is independent (override via SUPABASE_AUTH_BASE).
export const DEFAULT_AUTHORIZATION_SERVER =
  "https://artifacta.supabase.co/auth/v1";

/** Resolve the OAuth Authorization Server base URL for PRM `authorization_servers`.
 * Priority: explicit `authBase` → product default (vanity). Does not derive from
 * JWKS URL so operators can keep validation on the project-ref host. */
export function resolveAuthorizationServer(authBase?: string): string {
  const trimmedBase = authBase?.trim();
  if (trimmedBase) {
    return trimmedBase.replace(/\/+$/, "");
  }
  return DEFAULT_AUTHORIZATION_SERVER;
}
