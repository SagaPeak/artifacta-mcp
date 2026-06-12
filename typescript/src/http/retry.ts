import type { RetryPolicy } from "./types.js";

export const JITTER_BASE_MS = 50;
export const JITTER_CAP_MS = 500;
export const MAX_RETRIES_5XX = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Full jitter: random between [0, min(cap, base * 2^attempt)] */
function jitterMs(attempt: number): number {
  const ceil = Math.min(JITTER_CAP_MS, JITTER_BASE_MS * Math.pow(2, attempt));
  return Math.floor(Math.random() * ceil);
}

export interface RetryState {
  attempt: number;      // 0-based; 0 = initial call
  policy: RetryPolicy;
}

/** Returns true if a 5xx / network failure should trigger another attempt. */
export function shouldRetry5xx(state: RetryState): boolean {
  if (state.policy === "nonIdempotentWrite") return false;
  return state.attempt < MAX_RETRIES_5XX;
}

/**
 * Wait before a 5xx retry.
 * attempt=0 means "the initial call just failed; about to make attempt 1".
 */
export async function wait5xx(attempt: number): Promise<void> {
  await sleep(jitterMs(attempt));
}

/** Returns the delay in ms before retrying a 429, respecting Retry-After. */
export function retryAfterMs(
  retryAfterHeader: string | null,
  bodyRetryAfterSeconds: number | undefined
): number {
  const floor = 1000;
  if (retryAfterHeader !== null) {
    const parsed = parseFloat(retryAfterHeader);
    if (!isNaN(parsed) && parsed >= 0) return Math.max(floor, parsed * 1000);
  }
  if (bodyRetryAfterSeconds !== undefined) {
    return Math.max(floor, bodyRetryAfterSeconds * 1000);
  }
  return floor;
}

export async function wait429(
  retryAfterHeader: string | null,
  bodyRetryAfterSeconds: number | undefined
): Promise<void> {
  await sleep(retryAfterMs(retryAfterHeader, bodyRetryAfterSeconds));
}
