import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { getHttpClient } from "../http/instance.js";
import { translateHttpFailure } from "../errors/translate.js";
import { registerTool } from "../safety/registry.js";

// Plan §2.2 description — verbatim. The plan text is the contract.
export const LIST_ARTIFACTS_DESCRIPTION =
  "List artifacts owned by the calling tenant, newest first. Supports filters by `session_id`, `agent_id`, `filename` (exact match), `content_type`, `created_after` / `created_before` (ISO 8601), and one or more `metadata.<key>=<value>` pairs (multi-key requires Pro). Returns a page of artifact records and a `next_cursor` to fetch the next page. Use this to discover what an agent or pipeline produced when you only know a session or agent ID.";

const METADATA_KEY_PATTERN = "^[a-zA-Z][a-zA-Z0-9_-]{0,63}$";

const LIST_ARTIFACTS_LIMIT_DEFAULT = 50;

export const LIST_ARTIFACTS_TOOL: Tool = {
  name: "list_artifacts",
  description: LIST_ARTIFACTS_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      session_id: { type: "string" },
      agent_id: { type: "string" },
      filename: { type: "string" },
      content_type: { type: "string" },
      created_after: { type: "string", format: "date-time" },
      created_before: { type: "string", format: "date-time" },
      metadata: {
        type: "object",
        patternProperties: {
          [METADATA_KEY_PATTERN]: { type: "string" },
        },
        additionalProperties: false,
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 200,
        default: LIST_ARTIFACTS_LIMIT_DEFAULT,
      },
      cursor: {
        type: "string",
        description: "Opaque cursor from previous page's next_cursor.",
      },
    },
    required: [],
    additionalProperties: false,
  },
};

const FORWARD_STRING_KEYS = [
  "session_id",
  "agent_id",
  "filename",
  "content_type",
  "created_after",
  "created_before",
  "cursor",
] as const;

export interface ListArtifactsArgs {
  session_id?: string;
  agent_id?: string;
  filename?: string;
  content_type?: string;
  created_after?: string;
  created_before?: string;
  metadata?: Record<string, string>;
  limit?: number;
  cursor?: string;
}

/**
 * Build the GET /v1/artifacts query string from validated tool args.
 *
 * Forwarding rules:
 *  - String filters and `cursor` go through verbatim (cursor is opaque per
 *    plan §2.2 — never parsed, mutated, or validated locally).
 *  - `limit` defaults to 50 (plan §2.2 default; QA AF_MCP-2.2.08).
 *  - `metadata.<key>=<value>` is emitted one query param per entry; the
 *    server enforces the multi-key Pro gate (AF_CLI-9.1) and the key regex.
 */
export function buildListArtifactsPath(
  args: ListArtifactsArgs | undefined
): string {
  const params = new URLSearchParams();
  const a = args ?? {};

  for (const key of FORWARD_STRING_KEYS) {
    const value = a[key];
    if (typeof value === "string") {
      params.append(key, value);
    }
  }

  const limit =
    typeof a.limit === "number" ? a.limit : LIST_ARTIFACTS_LIMIT_DEFAULT;
  params.append("limit", String(limit));

  if (a.metadata && typeof a.metadata === "object") {
    for (const [key, value] of Object.entries(a.metadata)) {
      params.append(`metadata.${key}`, String(value));
    }
  }

  return `/v1/artifacts?${params.toString()}`;
}

export interface ListArtifactsResponse {
  artifacts: unknown[];
  next_cursor: string | null;
  has_more: boolean;
  [k: string]: unknown;
}

export const listArtifactsHandler = async (
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> => {
  const client = getHttpClient();
  const path = buildListArtifactsPath(args as ListArtifactsArgs | undefined);
  const result = await client.request<ListArtifactsResponse>({
    method: "GET",
    path,
    retryPolicy: "read",
  });
  if (result.ok) {
    return {
      content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
    };
  }
  return translateHttpFailure(result, "list_artifacts");
};

export function registerListArtifactsTool(): void {
  registerTool(LIST_ARTIFACTS_TOOL, "safe", listArtifactsHandler);
}
