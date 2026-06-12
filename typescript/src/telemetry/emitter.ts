/**
 * Anonymous opt-in telemetry emitter for the Artifacta MCP server.
 *
 * Per plan §9.4 / AF_MCP-1.7:
 *  - Default: off. Enabled with --telemetry=on.
 *  - Payload contract: { tool_name, latency_ms, success, error_code?, server_version }.
 *    No other fields permitted. Argument values, response bodies, and API key
 *    substrings are NEVER included.
 *  - Endpoint URL is deferred (Open Question #3); the placeholder transport is
 *    a no-op when off and a stderr writer when on. Call-site instrumentation
 *    is in place — flipping the transport is a one-line change.
 */

export type TelemetryMode = "off" | "on";

export interface TelemetryPayload {
  tool_name: string;
  latency_ms: number;
  success: boolean;
  error_code?: string;
  server_version: string;
}

/** The 5 allow-listed fields. Anything else is dropped before emit. */
export const ALLOWED_TELEMETRY_FIELDS: readonly (keyof TelemetryPayload)[] = [
  "tool_name",
  "latency_ms",
  "success",
  "error_code",
  "server_version",
] as const;

export type TelemetryTransport = (line: string) => void;

const STDERR_TRANSPORT: TelemetryTransport = (line) => {
  process.stderr.write(line + "\n");
};

let mode: TelemetryMode = "off";
let transport: TelemetryTransport = STDERR_TRANSPORT;

export function setTelemetryMode(m: TelemetryMode): void {
  mode = m;
}

export function getTelemetryMode(): TelemetryMode {
  return mode;
}

/** Test-only / future-extension hook: swap the transport (e.g., capture, file). */
export function setTelemetryTransport(t: TelemetryTransport): void {
  transport = t;
}

export function resetTelemetryTransport(): void {
  transport = STDERR_TRANSPORT;
}

export function resetTelemetry(): void {
  mode = "off";
  resetTelemetryTransport();
}

/**
 * Emit a telemetry record. No-op when mode is "off".
 * The payload is sanitized to the 5 allow-listed fields before write.
 * Transport errors are swallowed — telemetry must never crash the server.
 */
export function emitTelemetry(payload: TelemetryPayload): void {
  if (mode !== "on") return;

  const sanitized: Record<string, unknown> = {};
  const src = payload as unknown as Record<string, unknown>;
  for (const key of ALLOWED_TELEMETRY_FIELDS) {
    const v = src[key];
    if (v !== undefined) sanitized[key] = v;
  }

  try {
    transport(JSON.stringify(sanitized));
  } catch {
    // never throw from telemetry path
  }
}
