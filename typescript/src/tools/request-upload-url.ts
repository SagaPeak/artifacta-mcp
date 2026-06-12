// AF_MCP-3.2 — request_upload_url tool (Pro tier gate, no 5xx auto-retry).
//
// Reserves a presigned R2 PUT URL for files too large for store_artifact
// (over 500 MB, up to 5 GB). Maps to POST /v1/artifacts/upload-url. The input
// schema is plan §2.6 verbatim.
//
// RETRY POLICY: "nonIdempotentWrite" — the backend does NOT honor
// `Idempotency-Key` on this endpoint (§6.1/§6.2), so a 5xx after the pending
// row was inserted but before the response reached us could create duplicate
// pending artifacts on retry. The HTTP client therefore retries 429 once but
// NEVER auto-retries 5xx/network, and flags `ambiguousCompletion` on the
// failure so translateHttpFailure surfaces the §6.1 verification guidance.
// No `Idempotency-Key` is injected (the client gates injection to
// POST /v1/artifacts only). Revisit when Open Question #6 closes.
//
// DESCRIPTION DEVIATION (intentional — do not "restore verbatim"): the constant
// below is plan §2.6 verbatim PLUS a final ambiguous-completion warning sentence
// required by AF_MCP-3.2 AC #7 ("warns about ambiguous-completion semantics"),
// which the §2.6 text alone does not cover. QA AF_MCP-3.2.12 asserts only that
// the description steers toward `store_artifact` for smaller files (a substring
// check, no verbatim assertion), so the appended sentence is compliant. This
// mirrors the Phase 6a store_artifact precedent (store-artifact.ts:7–14).

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { getHttpClient } from "../http/instance.js";
import { translateHttpFailure } from "../errors/translate.js";
import { registerTool, type ToolCallContext } from "../safety/registry.js";
import { localInvalidRequest } from "./store-artifact-shared.js";
import { SESSION_ID_PATTERN, isSessionId } from "../ids/formats.js";

const MAX_SIZE_BYTES = 5368709120; // 5 GB — §2.6 ceiling

// Metadata key regex per CLAUDE.md — reject dots and leading digits at the schema.
const METADATA_KEY_PATTERN = "^[a-zA-Z][a-zA-Z0-9_-]{0,63}$";
const METADATA_KEY_RE = new RegExp(METADATA_KEY_PATTERN);

/**
 * Runtime validation of the `metadata` argument (the MCP SDK does not validate
 * inputSchema before dispatch). Mirrors the §2.6 schema's patternProperties +
 * value maxLength. Returns an error message, or null when valid.
 */
function validateMetadata(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "`metadata` must be an object of string values";
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!METADATA_KEY_RE.test(k)) {
      return `metadata key '${k}' is invalid; keys must match ${METADATA_KEY_PATTERN}`;
    }
    if (typeof v !== "string") {
      return `metadata value for '${k}' must be a string`;
    }
    if (v.length > 1024) {
      return `metadata value for '${k}' exceeds the 1024-character limit`;
    }
  }
  return null;
}

export const REQUEST_UPLOAD_URL_DESCRIPTION =
  "Reserve a presigned R2 PUT URL for a file too large to send through " +
  "`store_artifact` (over 500 MB up to 5 GB). Returns an `upload_url`, headers " +
  "to include in the PUT, and an `artifact_id` in `pending` state. The agent (or " +
  "its environment) PUTs the bytes directly to R2, then calls `complete_upload`. " +
  "Pro plan only. Most agents should use `store_artifact` and let the MCP server " +
  "pick the path automatically.\n\n" +
  "Not retry-safe: this endpoint does not support idempotency keys, so on an HTTP " +
  "5xx or network error the reservation may or may not have been created. Do NOT " +
  "blindly retry — the error guidance tells you to first call `list_artifacts` " +
  "with the same `session_id`/`agent_id` to detect any pending artifact, so you " +
  "don't create a duplicate.";

export const REQUEST_UPLOAD_URL_TOOL: Tool = {
  name: "request_upload_url",
  description: REQUEST_UPLOAD_URL_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      filename: { type: "string", minLength: 1, maxLength: 255 },
      content_type: { type: "string" },
      size_bytes: { type: "integer", minimum: 1, maximum: MAX_SIZE_BYTES },
      // session_id format constrained to keep the upload boundary in lockstep
      // with seal_session — see SESSION_ID_PATTERN in src/ids/formats.ts.
      session_id: { type: "string", pattern: SESSION_ID_PATTERN },
      agent_id: { type: "string" },
      metadata: {
        type: "object",
        patternProperties: {
          [METADATA_KEY_PATTERN]: { type: "string", maxLength: 1024 },
        },
        additionalProperties: false,
      },
      ttl: { type: "string" },
    },
    required: ["filename", "content_type", "size_bytes"],
    additionalProperties: false,
  },
};

interface UploadUrlBody {
  filename: string;
  content_type: string;
  size_bytes: number;
  session_id?: string;
  agent_id?: string;
  metadata?: Record<string, string>;
  ttl?: string;
  [k: string]: unknown;
}

interface UploadUrlResponse {
  artifact_id: string;
  status: string;
  upload_url: string;
  upload_expires_at: string;
  upload_method: string;
  upload_headers: Record<string, string>;
  [k: string]: unknown;
}

export const requestUploadUrlHandler = async (
  args: Record<string, unknown> | undefined,
  ctx?: ToolCallContext
): Promise<CallToolResult> => {
  const a: Record<string, unknown> = args ?? {};

  // The MCP SDK does not validate inputSchema before dispatch, so a
  // non-compliant client can send wrong types / out-of-range values. Validate
  // every field here so malformed input returns a structured invalid_request
  // instead of being forwarded unverified to the API.
  if (typeof a.filename !== "string" || a.filename.length < 1 || a.filename.length > 255) {
    return localInvalidRequest(
      "`filename` is required and must be a string of 1-255 characters"
    );
  }
  if (typeof a.content_type !== "string" || a.content_type.length < 1) {
    return localInvalidRequest("`content_type` is required and must be a non-empty string");
  }
  if (
    typeof a.size_bytes !== "number" ||
    !Number.isInteger(a.size_bytes) ||
    a.size_bytes < 1 ||
    a.size_bytes > MAX_SIZE_BYTES
  ) {
    return localInvalidRequest(
      `\`size_bytes\` is required and must be an integer from 1 to ${MAX_SIZE_BYTES} (5 GB)`
    );
  }

  // Optional string fields.
  for (const key of ["session_id", "agent_id", "ttl"] as const) {
    if (a[key] !== undefined && typeof a[key] !== "string") {
      return localInvalidRequest(`\`${key}\` must be a string`);
    }
  }

  // session_id format gate — defence at the upload boundary. The schema
  // `pattern` is the primary contract; this runtime guard catches
  // non-compliant clients that bypass schema validation.
  if (a.session_id !== undefined && !isSessionId(a.session_id as string)) {
    return localInvalidRequest(
      `\`session_id\` must match ${SESSION_ID_PATTERN} (alphanumeric start; alnum, dot, underscore, hyphen body; 1–128 chars)`
    );
  }

  // metadata: optional object of string values with constrained keys.
  if (a.metadata !== undefined) {
    const metaError = validateMetadata(a.metadata);
    if (metaError) return localInvalidRequest(metaError);
  }

  const body: UploadUrlBody = {
    filename: a.filename,
    content_type: a.content_type,
    size_bytes: a.size_bytes,
  };
  if (a.session_id !== undefined) body.session_id = a.session_id as string;
  if (a.agent_id !== undefined) body.agent_id = a.agent_id as string;
  if (a.metadata !== undefined) body.metadata = a.metadata as Record<string, string>;
  if (a.ttl !== undefined) body.ttl = a.ttl as string;

  const client = getHttpClient();
  const result = await client.request<UploadUrlResponse>({
    method: "POST",
    path: "/v1/artifacts/upload-url",
    body,
    // nonIdempotentWrite: 429 once, NEVER 5xx auto-retry. The client flags
    // ambiguousCompletion on failure → translateHttpFailure surfaces §6.1.
    // No Idempotency-Key injected (client gates injection to POST /v1/artifacts).
    retryPolicy: "nonIdempotentWrite",
    requestId: ctx?.requestId,
  });

  if (result.ok) {
    return {
      content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
    };
  }
  return translateHttpFailure(result, "request_upload_url");
};

export function registerRequestUploadUrlTool(): void {
  // safety: "writeNonIdempotent" — Pro-gated, no idempotency-key protection.
  // Default autonomous (§5.2 row: "✓ overridable"); no alwaysConfirm. The
  // ARTIFACTA_MCP_REQUIRE_WRITE_CONFIRM=1 promotion is handled by the registry
  // via WRITE_CONFIRM_TOOL_NAMES (which already includes request_upload_url).
  registerTool(REQUEST_UPLOAD_URL_TOOL, "writeNonIdempotent", requestUploadUrlHandler);
}
