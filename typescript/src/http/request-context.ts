// Request-scoped context for the hosted HTTP transport (AG-02).
//
// Stdio is single-tenant: one API key fixed at startup, one module-level HTTP
// client. Hosted HTTP is multi-tenant: every POST /mcp carries its own bearer,
// so the principal and the HTTP client that forwards its key must be scoped to
// the request rather than the process.
//
// We thread that scope through an AsyncLocalStorage store instead of rewriting
// every tool/resource handler to take a context argument. `getHttpClient()`
// (http/instance.ts) and the whoami key-suffix cache (whoami-cache.ts) read this
// store when it is present and fall back to their module-level singletons when it
// is not — so the stdio path is completely unchanged (the store is never set).
//
// The Principal shape is deliberately scope-aware so the OAuth work (AG-07)
// reuses this plumbing: an OAuthPrincipal populates `scopes` from validated JWT
// claims instead of the full set granted to API keys here.

import { AsyncLocalStorage } from "node:async_hooks";
import type { ArtifactaHttpClient } from "./client.js";

// Scope constants live in safety/scopes.ts (the authz module server.ts also
// imports). Re-exported here so existing http-layer imports are unchanged.
export {
  SCOPE_READ,
  SCOPE_WRITE,
  SCOPE_DESTROY,
  FULL_SCOPES,
} from "../safety/scopes.js";

/** A raw `ak_live_` bearer, forwarded verbatim to api.artifacta.io. Full scope. */
export interface ApiKeyPrincipal {
  kind: "api_key";
  /** The `ak_live_` token. Forwarded as `Authorization: Bearer`. NEVER logged. */
  token: string;
  scopes: readonly string[];
}

/** A validated Supabase OAuth JWT (AG-07). Calls the REST API through the
 * internal service path — the JWT is NEVER forwarded — and is gated to its
 * granted scopes. */
export interface OAuthPrincipal {
  kind: "oauth";
  /** Tenant resolved from the validated `tenant_id` claim. */
  tenantId: string;
  /** Granted artifacts:* scopes (the consented subset, NOT hierarchy-expanded).
   * Forwarded as `X-Artifacta-Scope`; expanded at the gate for tool filtering. */
  scopes: readonly string[];
  /** OAuth `client_id` claim — the revocation key (AG-10) and aud-narrowing id. */
  clientId?: string;
}

// Phase 0 had one principal kind; Phase 1 (AG-07) adds the OAuth principal.
export type Principal = ApiKeyPrincipal | OAuthPrincipal;

export interface RequestContext {
  principal: Principal;
  /** Per-request client whose Config carries this principal's key. */
  httpClient: ArtifactaHttpClient;
  /** Per-request scratch for the whoami key-suffix remediation hint. Kept here
   * (not in the module-level whoami cache) so one tenant's key suffix can never
   * surface in another tenant's auth-error message. */
  keySuffix?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` (and its entire async continuation) with `ctx` as the active store. */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** The active request context, or undefined on the stdio path. */
export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}
