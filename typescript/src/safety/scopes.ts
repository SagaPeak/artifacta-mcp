// OAuth scope model for the hosted MCP server (AG-07).
//
// Three OAuth scopes map onto the existing tool safety classes
// (src/safety/registry.ts):
//
//   artifacts:read    → `safe` tools + all resources
//   artifacts:write   → read + `writeIdempotent` / `writeNonIdempotent` tools
//   artifacts:destroy → write + `destructive` tools
//
// This coupling is deliberate and PINNED by test/http-oauth-scopes.test.ts so a
// future safety reclassification cannot silently re-grant a tool. The destroy
// trio (create_download_link, delete_artifact, seal_session) is identical to the
// API internal path's destructive gate (api/app/internal/auth.py) — the two
// enforcement points must agree.
//
// Lives under safety/ (not http/) so server.ts can import the gating helpers
// without pulling in the http client, and so the scope constants have a single
// home that the http layer re-exports (http/request-context.ts).

import { getToolRegistration, type ToolSafety } from "./registry.js";

export const SCOPE_READ = "artifacts:read";
export const SCOPE_WRITE = "artifacts:write";
export const SCOPE_DESTROY = "artifacts:destroy";

/** Every artifacts:* scope, in privilege order (read ⊆ write ⊆ destroy). */
export const ALL_SCOPES: readonly string[] = [
  SCOPE_READ,
  SCOPE_WRITE,
  SCOPE_DESTROY,
];

/** Full access — what an `ak_live_` API key grants (parity with stdio). */
export const FULL_SCOPES: readonly string[] = ALL_SCOPES;

/** The scope a tool requires, derived from its safety class. */
export function scopeForSafety(safety: ToolSafety): string {
  switch (safety) {
    case "safe":
      return SCOPE_READ;
    case "writeIdempotent":
    case "writeNonIdempotent":
      return SCOPE_WRITE;
    case "destructive":
      return SCOPE_DESTROY;
  }
}

/** The scope a registered tool requires, or undefined if the tool is unknown. */
export function requiredScopeForTool(name: string): string | undefined {
  const reg = getToolRegistration(name);
  return reg ? scopeForSafety(reg.safety) : undefined;
}

/**
 * Parse a raw OAuth `scope` claim (space-separated string) or `scopes` array
 * into the granted artifacts:* subset, de-duplicated and in privilege order.
 *
 * Unknown/OIDC scopes (openid, profile, email, …) are dropped. A missing or
 * garbage claim yields an EMPTY grant (auth succeeds, zero tools) rather than
 * throwing — fail-closed and visible. The live Supabase scope-claim shape is
 * unverified until the OAuth canary (AG-08 OPEN_QUESTION #1), so this is
 * deliberately defensive about the claim type.
 */
export function parseGrantedScopes(claim: unknown): string[] {
  let tokens: string[];
  if (typeof claim === "string") {
    tokens = claim.split(/\s+/);
  } else if (Array.isArray(claim)) {
    tokens = claim.filter((t): t is string => typeof t === "string");
  } else {
    tokens = [];
  }
  const granted = new Set(tokens);
  return ALL_SCOPES.filter((s) => granted.has(s));
}

/**
 * Expand granted scopes over the destroy ⊇ write ⊇ read hierarchy: a token
 * with `write` implicitly grants `read`; `destroy` implicitly grants
 * `write` + `read`. Matches the "Read scope plus …" / "Write scope plus …"
 * semantics in the spec scope table.
 */
export function expandScopes(granted: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const s of granted) {
    if (s === SCOPE_READ || s === SCOPE_WRITE || s === SCOPE_DESTROY) out.add(s);
  }
  if (out.has(SCOPE_DESTROY)) {
    out.add(SCOPE_WRITE);
    out.add(SCOPE_READ);
  }
  if (out.has(SCOPE_WRITE)) out.add(SCOPE_READ);
  return out;
}

/**
 * Whether an expanded scope set grants the named tool. Unknown tools are denied
 * under the gate (fail-closed). Callers pass the output of {@link expandScopes}.
 */
export function isToolGranted(name: string, expanded: ReadonlySet<string>): boolean {
  const required = requiredScopeForTool(name);
  if (required === undefined) return false;
  return expanded.has(required);
}

/** Resources (and resource templates) require the read scope. */
export function hasResourceAccess(expanded: ReadonlySet<string>): boolean {
  return expanded.has(SCOPE_READ);
}
