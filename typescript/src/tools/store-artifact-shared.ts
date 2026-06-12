// Shared types and result builders for the store_artifact tool family.
//
// store-artifact.ts (dispatcher), store-artifact-content.ts (JSON+base64 path),
// and store-artifact-path.ts (multipart path) all import from here. Keeping the
// shared surface in a leaf module avoids an import cycle between the dispatcher
// and its two sub-handlers.

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ArtifactRecord } from "./get-artifact.js";

/** Decoded-bytes ceiling for the inline `content` path (AF_CLI-1.2 JSON limit). */
export const MAX_CONTENT_DECODED_BYTES = 10 * 1024 * 1024; // 10 MB

export interface StoreArtifactArgs {
  filename: string;
  content?: string;
  path?: string;
  content_type?: string;
  session_id?: string;
  agent_id?: string;
  metadata?: Record<string, string>;
  ttl?: string;
  idempotency_key?: string;
}

/**
 * invalid_request result for argument errors the handler catches itself (the
 * MCP SDK does not validate inputSchema before dispatch, so non-compliant
 * clients can bypass their own validation). Text follows the §6 invalid_request
 * summary template: "Bad arguments: <message>. Adjust the inputs and call again."
 * `message` should NOT end with a period.
 */
export function localInvalidRequest(message: string): CallToolResult {
  return {
    isError: true,
    content: [
      { type: "text", text: `Bad arguments: ${message}. Adjust the inputs and call again.` },
    ],
    _meta: { code: "invalid_request", status: 400, retry_hint: "do_not_retry" },
  };
}

/**
 * invalid_request result for a path-confinement refusal. `reason` is the §4.4
 * verbatim refusal payload produced by the confinement engine (it already
 * begins with "invalid_request: ...").
 */
export function refusalResult(reason: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: reason }],
    _meta: { code: "invalid_request", status: 400, retry_hint: "do_not_retry" },
  };
}

/**
 * Success result: the full artifact record plus the idempotency key under
 * `_meta.idempotency_key`. For store_artifact the HTTP client always sets
 * injectedIdempotencyKey (the caller's own key when supplied, otherwise the
 * auto-generated `mcp_<uuid4>`), so the key is surfaced unconditionally — it is
 * the explicit hook an agent uses to deliberately replay later.
 */
export function successResult(
  record: ArtifactRecord,
  idempotencyKey?: string
): CallToolResult {
  const result: CallToolResult = {
    content: [{ type: "text", text: JSON.stringify(record, null, 2) }],
  };
  if (idempotencyKey) {
    result._meta = { idempotency_key: idempotencyKey };
  }
  return result;
}
