/** Caches the last 4 characters of the active API key from a successful whoami call. */

let cachedKeySuffix: string | undefined;

export function cacheKeySuffix(last4: string): void {
  cachedKeySuffix = last4;
}

export function getCachedKeySuffix(): string | undefined {
  return cachedKeySuffix;
}

export function clearKeySuffixCache(): void {
  cachedKeySuffix = undefined;
}
