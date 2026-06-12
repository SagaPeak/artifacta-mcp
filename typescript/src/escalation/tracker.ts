/**
 * Failure-escalation tracker.
 *
 * Per plan §6.3 / AF_MCP-1.7: when the MCP server itself fails (network
 * unreachable >30s on every retry, three consecutive HTTP failures with all
 * retries exhausted), emit MCP `notifications/message` at `level: error` and
 * KEEP serving. The process does NOT crash unless stdin is closed.
 *
 * Design:
 *  - Module-level counter, reset on any HTTP success.
 *  - When the threshold is crossed, the registered notifier is called once.
 *    The counter does not re-fire on subsequent failures until reset.
 *  - With no notifier registered, recordHttpResult is a silent no-op
 *    (so unit tests that exercise the HTTP client don't pollute notifications).
 */

export const OUTAGE_THRESHOLD = 3;
export const OUTAGE_MESSAGE =
  "Artifacta API unreachable; tool calls will fail until connectivity is restored.";

export type OutageNotifier = (message: string) => void;

let consecutiveFailures = 0;
let outageActive = false;
let notifier: OutageNotifier | null = null;

export function setOutageNotifier(fn: OutageNotifier): void {
  notifier = fn;
}

export function clearOutageNotifier(): void {
  notifier = null;
}

export function getConsecutiveFailures(): number {
  return consecutiveFailures;
}

export function isOutageActive(): boolean {
  return outageActive;
}

export function resetOutageState(): void {
  consecutiveFailures = 0;
  outageActive = false;
}

/**
 * Record the outcome of an HTTP attempt. `success: true` clears the outage
 * state and resets the counter. `success: false` increments; on the threshold
 * cross, the notifier fires once.
 *
 * Failures recorded with no notifier registered are tracked but do not emit
 * (used for tests that need predictable global state).
 */
export function recordHttpResult(success: boolean): void {
  if (success) {
    consecutiveFailures = 0;
    outageActive = false;
    return;
  }
  consecutiveFailures += 1;
  if (consecutiveFailures >= OUTAGE_THRESHOLD && !outageActive) {
    outageActive = true;
    if (notifier) {
      try {
        notifier(OUTAGE_MESSAGE);
      } catch {
        // never throw from the escalation path
      }
    }
  }
}
