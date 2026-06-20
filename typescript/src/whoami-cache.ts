/** Caches the last 4 characters of the active API key from a successful whoami
 * call, used only to enrich auth-failure remediation text (errors/translate.ts).
 *
 * On the hosted HTTP path this would be cross-tenant unsafe: one tenant's whoami
 * would populate a process-global suffix that could then appear in another
 * tenant's auth error. So when a request context is active (HTTP), the suffix is
 * stored on that per-request context instead of the module global. Stdio has no
 * request context and uses the module global exactly as before. */

import { getRequestContext } from "./http/request-context.js";

let cachedKeySuffix: string | undefined;

export function cacheKeySuffix(last4: string): void {
  const ctx = getRequestContext();
  if (ctx) {
    ctx.keySuffix = last4;
    return;
  }
  cachedKeySuffix = last4;
}

export function getCachedKeySuffix(): string | undefined {
  const ctx = getRequestContext();
  if (ctx) return ctx.keySuffix;
  return cachedKeySuffix;
}

export function clearKeySuffixCache(): void {
  cachedKeySuffix = undefined;
}
