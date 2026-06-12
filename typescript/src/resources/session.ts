import {
  ErrorCode,
  McpError,
  type ReadResourceResult,
  type ResourceTemplate,
} from "@modelcontextprotocol/sdk/types.js";
import { getHttpClient } from "../http/instance.js";
import { translateHttpFailure } from "../errors/translate.js";
import { registerResourceTemplate } from "./registry.js";
import type {
  ListSessionsResponse,
  SessionEntry,
} from "../tools/list-sessions.js";

export const SESSION_RESOURCE_TEMPLATE: ResourceTemplate = {
  uriTemplate: "artifacta://session/{session_id}",
  name: "session",
  description:
    "Aggregate view of a single session: session_id, artifact_count, is_sealed, first_artifact_at, last_artifact_at. Backed by the same data as the `list_sessions` tool.",
  mimeType: "application/json",
};

// `/v1/sessions` page size. The walker below relies on the API's
// `has_more` terminator — NOT a fixed page count — to decide whether the
// target genuinely doesn't exist. The cap below is a defensive circuit
// breaker, not a UX boundary.
const PAGE_SIZE = 200;

// Defensive safety cap on the pagination walk. Picked at a level no real v1
// tenant should reach: 200 pages × 200 sessions/page = 40,000 sessions. Sole
// purpose is to guard against an API pagination bug or runaway loop —
// hitting this is unexpected. When it does fire, the resource MUST surface
// a DISTINCT error from session_not_found so the agent can fall back to
// `list_artifacts?session_id=<id>` rather than incorrectly conclude the
// session is gone.
const SAFETY_PAGE_CAP = 200;

/**
 * Aggregate-view read of `artifacta://session/{session_id}`.
 *
 * Implementation note: the Artifacta API exposes `/v1/sessions` (the
 * AF_CLI-7.2 endpoint), which already aggregates `artifact_count`,
 * `is_sealed`, `first_artifact_at`, `last_artifact_at` server-side. This
 * reader paginates that endpoint until it finds the target session_id OR
 * the API reports `has_more: false`. The alternative path
 * (`list_artifacts?session_id=…` + client-side aggregation) cannot recover
 * `is_sealed`, since seal state is stored on the session, not artifacts —
 * see AF_MCP-2.5 task notes.
 *
 * Termination semantics — the failure mode the resource read is
 * RESPONSIBLE for distinguishing:
 *   - Found in a page                     → return the aggregate row.
 *   - `has_more: false` reached, no match → §6 session_not_found
 *                                           (definitive: the API has
 *                                           enumerated all sessions and
 *                                           none matched).
 *   - Safety cap fires before either of   → DISTINCT "search exhausted"
 *     the above terminators (extremely      error so the agent can fall
 *     unlikely under v1 traffic).           back to `list_artifacts` for
 *                                           the artifact-level view; the
 *                                           session may still exist.
 *
 * Adversarial-review fix (Codex review of HEAD~6..HEAD, 2026-05-08):
 * the previous implementation capped at 10 pages and returned
 * session_not_found on cap-hit, making "exists but deep in history"
 * indistinguishable from "does not exist." That violated the plan §3
 * contract for stable URI-addressable resources.
 */
async function readSessionResource(
  uri: string,
  params: Record<string, string>
): Promise<ReadResourceResult> {
  const targetId = params.session_id;
  if (!targetId) {
    throw new McpError(ErrorCode.InvalidParams, `Malformed URI: ${uri}`);
  }
  const client = getHttpClient();
  let cursor: string | undefined;
  let page = 0;
  while (page < SAFETY_PAGE_CAP) {
    const search = new URLSearchParams();
    search.append("limit", String(PAGE_SIZE));
    if (cursor) search.append("after", cursor);
    const path = `/v1/sessions?${search.toString()}`;

    const result = await client.request<ListSessionsResponse>({
      method: "GET",
      path,
      retryPolicy: "read",
    });
    if (!result.ok) {
      const translated = translateHttpFailure(result, "session_resource");
      const text =
        translated.content[0]?.type === "text"
          ? translated.content[0].text
          : `Artifacta API error: ${result.error.code}`;
      const isClientError = result.status >= 400 && result.status < 500;
      throw new McpError(
        isClientError ? ErrorCode.InvalidRequest : ErrorCode.InternalError,
        text
      );
    }
    const found = (result.data?.sessions ?? []).find(
      (s: SessionEntry) => s.session_id === targetId
    );
    if (found) {
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(found, null, 2),
          },
        ],
      };
    }

    // Definitive not-found: the API has enumerated every session for this
    // tenant and none matched. Surface §6 verbatim so the agent gets the
    // same remediation it would on the tool path.
    if (!result.data?.has_more) {
      const text = `No artifacts exist for session ${targetId}. Sessions are synthesized from artifacts — create one first.`;
      throw new McpError(ErrorCode.InvalidRequest, text);
    }
    const next = result.data.next_cursor;
    if (typeof next !== "string" || next.length === 0) {
      // Defensive: API said `has_more` but didn't give us a cursor. Treat
      // identically to has_more:false to avoid an infinite loop on a buggy
      // response.
      const text = `No artifacts exist for session ${targetId}. Sessions are synthesized from artifacts — create one first.`;
      throw new McpError(ErrorCode.InvalidRequest, text);
    }
    cursor = next;
    page++;
  }

  // Safety cap fired — distinct from session_not_found. The session MAY
  // still exist past page SAFETY_PAGE_CAP; the agent should fall back to
  // the artifact-level view rather than treating the session as gone.
  const text =
    `Session aggregate search exhausted ${SAFETY_PAGE_CAP} pages of /v1/sessions without finding ${targetId} and the API still reports has_more=true. ` +
    `Session may exist deeper in history but the aggregate view (artifact_count, is_sealed, first_artifact_at, last_artifact_at) is unavailable. ` +
    `Fall back to list_artifacts with session_id="${targetId}" for the artifact-level view.`;
  throw new McpError(ErrorCode.InternalError, text);
}

export function registerSessionResource(): void {
  registerResourceTemplate(SESSION_RESOURCE_TEMPLATE, readSessionResource);
}
