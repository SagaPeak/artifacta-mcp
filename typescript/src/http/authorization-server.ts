// Supabase Auth is the OAuth 2.1 Authorization Server (HM-02). Trailing-slash-
// free, matching the issuer returned by its OIDC discovery document. The
// protected-resource metadata must advertise that canonical issuer; operators
// can override it for a different authorization server.
export const DEFAULT_AUTHORIZATION_SERVER =
  "https://vliolvdztzcrtuolrgdi.supabase.co/auth/v1";

/** Resolve the OAuth Authorization Server base URL for PRM `authorization_servers`.
 * Priority: explicit `authBase` → canonical production issuer. Does not derive
 * from JWKS URL so operators can keep validation on a separate host. */
export function resolveAuthorizationServer(authBase?: string): string {
  const trimmedBase = authBase?.trim();
  if (trimmedBase) {
    return trimmedBase.replace(/\/+$/, "");
  }
  return DEFAULT_AUTHORIZATION_SERVER;
}
