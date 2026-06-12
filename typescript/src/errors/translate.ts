import {
  AGENT_SUMMARIES,
  AMBIGUOUS_COMPLETION_GUIDANCE,
  SERVER_5XX_SUMMARY,
  TENANT_SUSPENDED_SUMMARY,
  AUTH_REMEDIATION_TEMPLATE,
} from "./messages.js";
import { getCachedKeySuffix } from "../whoami-cache.js";
import type { HttpFailure } from "../http/types.js";

export type RetryHint =
  | "do_not_retry"
  | "retry_after"
  | "retry_with_backoff";

export interface McpErrorMeta {
  status: number;
  code: string;
  retry_hint: RetryHint;
  upgrade_url?: string;
  retry_after_seconds?: number;
  // Index signature so this satisfies the MCP SDK's `_meta` shape, which
  // expects `{ [x: string]: unknown }` plus a couple of reserved keys.
  [k: string]: unknown;
}

export interface McpErrorResult {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
  _meta: McpErrorMeta;
  // Index signature so this satisfies CallToolResult's open shape.
  [k: string]: unknown;
}

const RETRY_HINTS: Record<string, RetryHint> = {
  invalid_request: "do_not_retry",
  unauthorized: "do_not_retry",
  quota_exceeded: "do_not_retry",
  ttl_exceeds_plan_limit: "do_not_retry",
  artifact_not_found: "do_not_retry",
  session_not_found: "do_not_retry",
  session_sealed: "do_not_retry",
  artifact_expired: "do_not_retry",
  artifact_already_deleted: "do_not_retry",
  file_too_large: "do_not_retry",
  upload_not_found: "do_not_retry",
  rate_limited: "retry_after",
  network_error: "retry_with_backoff",
  server_error: "retry_with_backoff",
};

function fill(template: string, vars: Record<string, string | undefined>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}

function buildAuthText(message: string): string {
  const keySuffix = getCachedKeySuffix();
  const suffixFragment = keySuffix
    ? ` Last-known key suffix: ****${keySuffix}.`
    : "";
  return fill(AUTH_REMEDIATION_TEMPLATE, {
    message,
    keySuffix: suffixFragment,
  });
}

function buildSummaryText(
  code: string,
  errorObj: HttpFailure["error"],
  extraVars?: Record<string, string | undefined>
): string {
  const template = AGENT_SUMMARIES[code];
  if (!template) {
    return `Artifacta error (${code}): ${errorObj.message}`;
  }
  const vars: Record<string, string | undefined> = {
    message: errorObj.message,
    upgrade_url: errorObj.upgrade_url,
    ...extraVars,
  };
  return fill(template, vars);
}

/**
 * @param extraVars Optional template variables for the §6 summary line. Callers
 *   that know the artifact/session id should pass `{ id }` to fill the `{{id}}`
 *   placeholder in id-bearing summaries (artifact_not_found, artifact_expired,
 *   artifact_already_deleted, upload_not_found, session_sealed). When omitted the
 *   placeholder renders empty — the existing get_artifact / list_sessions
 *   behavior, intentionally left unchanged here (opt-in per tool).
 */
export function translateHttpFailure(
  failure: HttpFailure,
  toolName?: string,
  extraVars?: Record<string, string | undefined>
): McpErrorResult {
  const { code, status, upgrade_url } = failure.error;
  const retryAfterSecs = failure.error.retry_after;

  // Ambiguous-completion guidance for non-retryable write failures
  if (failure.ambiguousCompletion && toolName) {
    const guidanceText = fill(AMBIGUOUS_COMPLETION_GUIDANCE, { tool: toolName });
    return {
      isError: true,
      content: [{ type: "text", text: guidanceText }],
      _meta: {
        status: status || 0,
        code: code ?? "server_error",
        retry_hint: "do_not_retry",
      },
    };
  }

  // Tenant suspended (account in deletion grace period)
  if (code === "unauthorized" && failure.error.message?.toLowerCase().includes("suspended")) {
    return {
      isError: true,
      content: [{ type: "text", text: TENANT_SUSPENDED_SUMMARY }],
      _meta: {
        status,
        code,
        retry_hint: "do_not_retry",
        upgrade_url,
      },
    };
  }

  // Auth failure with structured remediation
  if (code === "unauthorized") {
    const text = buildAuthText(failure.error.message);
    return {
      isError: true,
      content: [{ type: "text", text }],
      _meta: {
        status,
        code,
        retry_hint: "do_not_retry",
      },
    };
  }

  // 5xx / network (non-ambiguous) — includes retry count
  if (code === "server_error" || code === "network_error" || (status >= 500 && status < 600)) {
    const text = fill(SERVER_5XX_SUMMARY, {
      status: String(status),
      n: String(failure.attempts),
    });
    return {
      isError: true,
      content: [{ type: "text", text }],
      _meta: {
        status: status || 0,
        code: code ?? "server_error",
        retry_hint: "retry_with_backoff",
      },
    };
  }

  // rate_limited with retry_after info
  if (code === "rate_limited") {
    const text = buildSummaryText(code, failure.error, {
      retry_after_seconds: retryAfterSecs !== undefined ? String(retryAfterSecs) : "unknown",
      limit: "unknown",
    });
    return {
      isError: true,
      content: [{ type: "text", text }],
      _meta: {
        status,
        code,
        retry_hint: "retry_after",
        retry_after_seconds: retryAfterSecs,
      },
    };
  }

  // All other codes from CLAUDE.md taxonomy
  const text = buildSummaryText(code, failure.error, extraVars);
  const retryHint: RetryHint = RETRY_HINTS[code] ?? "do_not_retry";

  return {
    isError: true,
    content: [{ type: "text", text }],
    _meta: {
      status,
      code,
      retry_hint: retryHint,
      upgrade_url,
    },
  };
}
