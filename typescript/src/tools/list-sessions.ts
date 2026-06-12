import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { getHttpClient } from "../http/instance.js";
import { translateHttpFailure } from "../errors/translate.js";
import { registerTool } from "../safety/registry.js";

// Plan §2.10 description — verbatim. The plan text is the contract.
export const LIST_SESSIONS_DESCRIPTION =
  "List session IDs synthesized from the calling tenant's artifacts, ordered by most recent activity. Each entry includes artifact count, seal status, and first/last activity timestamps. Sessions are not first-class — they exist only as long as artifacts reference them.";

const LIST_SESSIONS_LIMIT_DEFAULT = 50;

export const LIST_SESSIONS_TOOL: Tool = {
  name: "list_sessions",
  description: LIST_SESSIONS_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      created_after: { type: "string", format: "date-time" },
      created_before: { type: "string", format: "date-time" },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 200,
        default: LIST_SESSIONS_LIMIT_DEFAULT,
      },
      cursor: { type: "string" },
    },
    required: [],
    additionalProperties: false,
  },
};

export interface ListSessionsArgs {
  created_after?: string;
  created_before?: string;
  limit?: number;
  cursor?: string;
}

/**
 * Build the GET /v1/sessions query string from validated tool args.
 *
 * The Artifacta API uses query param `after` for the session-list cursor
 * (vs. `cursor` for artifacts). The MCP boundary keeps `cursor` for agent
 * consistency and translates here.
 *
 * `limit` defaults to 50 client-side per plan §2.10 / QA AF_MCP-2.5.07.
 */
export function buildListSessionsPath(args: ListSessionsArgs | undefined): string {
  const params = new URLSearchParams();
  const a = args ?? {};

  if (typeof a.created_after === "string")
    params.append("created_after", a.created_after);
  if (typeof a.created_before === "string")
    params.append("created_before", a.created_before);

  const limit =
    typeof a.limit === "number" ? a.limit : LIST_SESSIONS_LIMIT_DEFAULT;
  params.append("limit", String(limit));

  if (typeof a.cursor === "string") {
    params.append("after", a.cursor);
  }

  return `/v1/sessions?${params.toString()}`;
}

export interface SessionEntry {
  session_id: string;
  artifact_count: number;
  is_sealed: boolean;
  first_artifact_at: string;
  last_artifact_at: string;
  [k: string]: unknown;
}

export interface ListSessionsResponse {
  sessions: SessionEntry[];
  next_cursor: string | null;
  has_more: boolean;
  [k: string]: unknown;
}

export const listSessionsHandler = async (
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> => {
  const client = getHttpClient();
  const path = buildListSessionsPath(args as ListSessionsArgs | undefined);
  const result = await client.request<ListSessionsResponse>({
    method: "GET",
    path,
    retryPolicy: "read",
  });
  if (result.ok) {
    return {
      content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
    };
  }
  return translateHttpFailure(result, "list_sessions");
};

export function registerListSessionsTool(): void {
  registerTool(LIST_SESSIONS_TOOL, "safe", listSessionsHandler);
}
