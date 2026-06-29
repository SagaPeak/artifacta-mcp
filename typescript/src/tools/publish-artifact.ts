// Task 9 — publish_artifact tool (Artifact Pages publish path).
//
// Publishes an existing artifact as a shareable public page. Maps to
// POST /v1/artifacts/{id}/publish. Returns {page_id, public_url, visibility, access}.
//
// SAFETY: "writeIdempotent" — re-publishing the same artifact_id upserts the
// existing page and keeps the same URL (idempotent per the API contract).
//
// RETRY POLICY: "idempotentWrite" — safe to retry on 5xx; the backend treats
// repeated publish calls as upserts, not duplicate inserts.

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { getHttpClient } from "../http/instance.js";
import { translateHttpFailure } from "../errors/translate.js";
import { registerTool, type ToolCallContext } from "../safety/registry.js";
import { localInvalidRequest } from "./store-artifact-shared.js";

export const PUBLISH_ARTIFACT_DESCRIPTION =
  "Publish an existing artifact as a polished, shareable public page at " +
  "https://artifacta.io/a/{slug}. Composes with store_artifact (store first, then publish). " +
  "Returns a public_url anyone can open without an Artifacta account. Default visibility is " +
  "unlisted (link-only); pass visibility:\"public\" for gallery-eligible later. Idempotent: " +
  "re-publishing the same artifact_id updates the existing page and keeps the same URL.";

export const PUBLISH_ARTIFACT_TOOL: Tool = {
  name: "publish_artifact",
  description: PUBLISH_ARTIFACT_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      artifact_id: { type: "string", minLength: 1 },
      title: { type: "string", maxLength: 255 },
      visibility: { type: "string", enum: ["unlisted", "public"] },
      access: { type: "string", enum: ["none", "password"] },
    },
    required: ["artifact_id"],
    additionalProperties: false,
  },
};

export const publishArtifactHandler = async (
  args: Record<string, unknown> | undefined,
  ctx?: ToolCallContext
): Promise<CallToolResult> => {
  const a: Record<string, unknown> = args ?? {};

  if (typeof a.artifact_id !== "string" || a.artifact_id.length < 1) {
    return localInvalidRequest("`artifact_id` is required and must be a non-empty string");
  }

  const body: Record<string, unknown> = {
    visibility: a.visibility ?? "unlisted",
    access: a.access ?? "none",
  };
  if (typeof a.title === "string") body.title = a.title;

  const client = getHttpClient();
  const result = await client.request({
    method: "POST",
    path: `/v1/artifacts/${a.artifact_id}/publish`,
    body,
    retryPolicy: "idempotentWrite",
    requestId: ctx?.requestId,
  });

  if (result.ok) {
    return {
      content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
    };
  }
  return translateHttpFailure(result, "publish_artifact");
};

export function registerPublishArtifactTool(): void {
  registerTool(PUBLISH_ARTIFACT_TOOL, "writeIdempotent", publishArtifactHandler);
}
