/**
 * Defensive guard against forbidden substrings in telemetry payloads.
 *
 * Per plan §9.4 / AF_MCP-1.7: telemetry NEVER includes argument values,
 * response bodies, or any string from the user's data plane. The emitter
 * only assembles allow-listed fields, but this module is the unit-test
 * tripwire that asserts the invariant.
 */

export interface ForbiddenMatch {
  found: boolean;
  field?: string;
  needle?: string;
}

/**
 * Returns true if any value in `payload` (when stringified) contains any
 * non-empty `needle` from `forbidden`. Empty needles are skipped.
 */
export function containsAnyForbidden(
  payload: Record<string, unknown>,
  forbidden: readonly string[]
): ForbiddenMatch {
  for (const [field, value] of Object.entries(payload)) {
    const haystack = stringifyForScan(value);
    for (const needle of forbidden) {
      if (!needle) continue;
      if (haystack.includes(needle)) {
        return { found: true, field, needle };
      }
    }
  }
  return { found: false };
}

/**
 * Throws if `payload` contains any of the forbidden substrings.
 * Use in unit tests to guarantee redaction is enforced.
 */
export function assertSafeTelemetry(
  payload: Record<string, unknown>,
  forbidden: readonly string[]
): void {
  const match = containsAnyForbidden(payload, forbidden);
  if (match.found) {
    throw new Error(
      `Telemetry payload leaked forbidden substring "${match.needle}" in field "${match.field}"`
    );
  }
}

function stringifyForScan(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
