import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { getHttpClient } from "../http/instance.js";
import type { HttpFailure } from "../http/types.js";
import { translateHttpFailure } from "../errors/translate.js";
import { registerTool } from "../safety/registry.js";
import { ARTIFACT_ID_PATTERN } from "../ids/formats.js";

// Plan §2.4 description — verbatim. The plan text is the contract; the
// reference to `create_download_link` is the LLM-facing steer for human
// sharing scenarios.
export const GET_ARTIFACT_DOWNLOAD_URL_DESCRIPTION =
  "Generate a short-lived presigned URL (1 hour) the agent can use to download the artifact's bytes directly from Cloudflare R2. Use this when the agent itself needs to consume the file. For sharing with humans, use `create_download_link` instead — that produces a stable `dl.artifacta.io/lnk_…` URL with configurable expiry.";

export const GET_ARTIFACT_DOWNLOAD_URL_TOOL: Tool = {
  name: "get_artifact_download_url",
  description: GET_ARTIFACT_DOWNLOAD_URL_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      artifact_id: { type: "string", pattern: ARTIFACT_ID_PATTERN },
    },
    required: ["artifact_id"],
    additionalProperties: false,
  },
};

export interface DownloadUrlResponse {
  download_url: string;
  expires_in: number;
  filename: string;
  content_type: string;
  size_bytes: number;
  [k: string]: unknown;
}

export type FetchDownloadUrlResult =
  | { ok: true; data: DownloadUrlResponse }
  | { ok: false; failure: HttpFailure };

/** Shared GET /v1/artifacts/{id}/download-url fetch used by both the tool handler
 * and the `artifacta://artifact/{id}/bytes` resource (AF_MCP-3.5). */
export async function fetchDownloadUrl(
  artifactId: string
): Promise<FetchDownloadUrlResult> {
  const client = getHttpClient();
  const result = await client.request<DownloadUrlResponse>({
    method: "GET",
    path: `/v1/artifacts/${encodeURIComponent(artifactId)}/download-url`,
    retryPolicy: "read",
  });
  if (result.ok) return { ok: true, data: result.data };
  return { ok: false, failure: result };
}

export const getArtifactDownloadUrlHandler = async (
  args: Record<string, unknown> | undefined
): Promise<CallToolResult> => {
  const artifactId = (args ?? {}).artifact_id;
  if (typeof artifactId !== "string") {
    // Defensive runtime guard for non-compliant clients that bypass schema
    // validation. The Ajv parametric gate is the primary defense.
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
  const r = await fetchDownloadUrl(artifactId);
  if (r.ok) {
    return {
      content: [{ type: "text", text: JSON.stringify(r.data, null, 2) }],
    };
  }
  return translateHttpFailure(r.failure, "get_artifact_download_url");
};

export function registerGetArtifactDownloadUrlTool(): void {
  registerTool(
    GET_ARTIFACT_DOWNLOAD_URL_TOOL,
    "safe",
    getArtifactDownloadUrlHandler
  );
}
