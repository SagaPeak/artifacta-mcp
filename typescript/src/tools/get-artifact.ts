import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { getHttpClient } from "../http/instance.js";
import type { HttpFailure } from "../http/types.js";
import { translateHttpFailure } from "../errors/translate.js";
import { registerTool } from "../safety/registry.js";
import { ARTIFACT_ID_PATTERN } from "../ids/formats.js";

// Plan §2.3 description — verbatim. The plan text is the contract.
export const GET_ARTIFACT_DESCRIPTION =
  "Fetch metadata for a single artifact by ID: filename, content type, size, content hash, session/agent IDs, custom metadata, expiry, creation timestamp. Does NOT return the file bytes — call `get_artifact_download_url` for that. Returns `artifact_not_found` for unknown IDs, `artifact_already_deleted` (HTTP 410) for soft-deleted ones, `artifact_expired` (410) for those past their TTL.";

export const GET_ARTIFACT_TOOL: Tool = {
  name: "get_artifact",
  description: GET_ARTIFACT_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      artifact_id: { type: "string", pattern: ARTIFACT_ID_PATTERN },
    },
    required: ["artifact_id"],
    additionalProperties: false,
  },
};

export interface ArtifactRecord {
  artifact_id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  content_hash: string;
  session_id?: string | null;
  agent_id?: string | null;
  metadata?: Record<string, string>;
  expires_at?: string | null;
  created_at: string;
  [k: string]: unknown;
}

export type GetArtifactResult =
  | { ok: true; data: ArtifactRecord }
  | { ok: false; failure: HttpFailure };

/** Shared GET /v1/artifacts/{id} fetch used by both the tool handler and the
 * `artifacta://artifact/{id}` resource read handler. */
export async function fetchArtifact(
  artifactId: string
): Promise<GetArtifactResult> {
  const client = getHttpClient();
  const result = await client.request<ArtifactRecord>({
    method: "GET",
    path: `/v1/artifacts/${encodeURIComponent(artifactId)}`,
    retryPolicy: "read",
  });
  if (result.ok) return { ok: true, data: result.data };
  return { ok: false, failure: result };
}

export const getArtifactHandler = async (
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> => {
  const artifactId = (args ?? {}).artifact_id;
  if (typeof artifactId !== "string") {
    // The MCP SDK does not validate inputSchema before dispatch; this catches
    // a non-compliant client that bypasses its own validation. The schema
    // gate in tests/qa is the primary defense.
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "Bad arguments: artifact_id is required and must match ^art_[A-Za-z0-9]{16}$.",
        },
      ],
      _meta: { code: "invalid_request", status: 400, retry_hint: "do_not_retry" },
    };
  }
  const r = await fetchArtifact(artifactId);
  if (r.ok) {
    return {
      content: [{ type: "text", text: JSON.stringify(r.data, null, 2) }],
    };
  }
  return translateHttpFailure(r.failure, "get_artifact");
};

export function registerGetArtifactTool(): void {
  registerTool(GET_ARTIFACT_TOOL, "safe", getArtifactHandler);
}
