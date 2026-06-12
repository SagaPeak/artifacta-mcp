/**
 * Structured JSON logger for the Artifacta MCP server.
 *
 * Per AF_MCP-1.7:
 *  - 8 MCP levels (debug → emergency); default is `notice`
 *  - All output to stderr (stdout is reserved for the JSON-RPC channel)
 *  - Single-line JSON: { ts, level, msg, ...extras }
 *  - Level mutable at runtime via setLogLevel() — wired to MCP `logging/setLevel`
 */

export type LogLevel =
  | "debug"
  | "info"
  | "notice"
  | "warning"
  | "error"
  | "critical"
  | "alert"
  | "emergency";

export const LOG_LEVELS: readonly LogLevel[] = [
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency",
] as const;

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  notice: 2,
  warning: 3,
  error: 4,
  critical: 5,
  alert: 6,
  emergency: 7,
};

export const DEFAULT_LOG_LEVEL: LogLevel = "notice";

let currentLevel: LogLevel = DEFAULT_LOG_LEVEL;
let writer: (line: string) => void = (line) => {
  process.stderr.write(line + "\n");
};

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && value in LEVEL_RANK;
}

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

/** Test-only: swap the stderr writer for capture. */
export function setLogWriter(fn: (line: string) => void): void {
  writer = fn;
}

/** Test-only: restore the default stderr writer. */
export function resetLogWriter(): void {
  writer = (line) => {
    process.stderr.write(line + "\n");
  };
}

/** Test-only: reset level back to default. */
export function resetLogger(): void {
  currentLevel = DEFAULT_LOG_LEVEL;
  resetLogWriter();
}

export interface LogExtras {
  tool?: string;
  request_id?: string;
  [key: string]: unknown;
}

function emit(level: LogLevel, msg: string, extras?: LogExtras): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[currentLevel]) return;
  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
  };
  if (extras) {
    for (const [k, v] of Object.entries(extras)) {
      if (v !== undefined) record[k] = v;
    }
  }
  writer(JSON.stringify(record));
}

export const logger = {
  debug(msg: string, extras?: LogExtras): void {
    emit("debug", msg, extras);
  },
  info(msg: string, extras?: LogExtras): void {
    emit("info", msg, extras);
  },
  notice(msg: string, extras?: LogExtras): void {
    emit("notice", msg, extras);
  },
  warning(msg: string, extras?: LogExtras): void {
    emit("warning", msg, extras);
  },
  error(msg: string, extras?: LogExtras): void {
    emit("error", msg, extras);
  },
  critical(msg: string, extras?: LogExtras): void {
    emit("critical", msg, extras);
  },
  alert(msg: string, extras?: LogExtras): void {
    emit("alert", msg, extras);
  },
  emergency(msg: string, extras?: LogExtras): void {
    emit("emergency", msg, extras);
  },
};
