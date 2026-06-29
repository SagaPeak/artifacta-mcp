// Task 9 — unpublish_artifact tool (Artifact Pages publish path).
//
// Soft-unpublishes an artifact's public page. Maps to
// DELETE /v1/artifacts/{id}/publish. The artifact itself is not deleted.
//
// SAFETY: "writeIdempotent" — the API treats repeated unpublish calls as
// no-ops when the page is already unpublished.
//
// RETRY POLICY: "idempotentWrite" — safe to retry on 5xx.

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { getHttpClient } from "../http/instance.js";
import { translateHttpFailure } from "../errors/translate.js";
import { registerTool, type ToolCallContext } from "../safety/registry.js";
import { localInvalidRequest } from "./store-artifact-shared.js";

export const UNPUBLISH_ARTIFACT_DESCRIPTION =
  "Remove the public page for an artifact, making the public URL inaccessible. The artifact " +
  "itself is not deleted — only its shareable page is taken down. The URL stops resolving " +
  "immediately. Idempotent: calling unpublish on an already-unpublished artifact is a no-op.";

export const UNPUBLISH_ARTIFACT_TOOL: Tool = {
  name: "unpublish_artifact",
  description: UNPUBLISH_ARTIFACT_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      artifact_id: { type: "string", minLength: 1 },
    },
    required: ["artifact_id"],
    additionalProperties: false,
  },
};

export const unpublishArtifactHandler = async (
  args: Record<string, unknown> | undefined,
  ctx?: ToolCallContext
): Promise<CallToolResult> => {
  const a: Record<string, unknown> = args ?? {};

  if (typeof a.artifact_id !== "string" || a.artifact_id.length < 1) {
    return localInvalidRequest("`artifact_id` is required and must be a non-empty string");
  }

  const client = getHttpClient();
  const result = await client.request({
    method: "DELETE",
    path: `/v1/artifacts/${a.artifact_id}/publish`,
    retryPolicy: "idempotentWrite",
    requestId: ctx?.requestId,
  });

  if (result.ok) {
    return {
      content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
    };
  }
  return translateHttpFailure(result, "unpublish_artifact");
};

export function registerUnpublishArtifactTool(): void {
  registerTool(UNPUBLISH_ARTIFACT_TOOL, "writeIdempotent", unpublishArtifactHandler);
}
