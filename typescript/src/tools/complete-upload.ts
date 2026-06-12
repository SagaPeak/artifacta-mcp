// AF_MCP-3.3 — complete_upload tool.
//
// Finalizes an artifact reserved via request_upload_url after the agent has PUT
// the bytes to the presigned R2 URL. Maps to POST /v1/artifacts/{id}/complete.
// The input schema and description are plan §2.7 verbatim.
//
// RETRY POLICY: "idempotentWrite" — naturally idempotent. A second call on an
// already-active artifact returns the existing record (api/app/routers/
// artifacts.py:410-411), so 5xx/network is safe to auto-retry (429 once, 5xx up
// to 3× with jitter). NO Idempotency-Key is injected (§6.2): the client gates
// auto-injection to POST /v1/artifacts only, and the natural idempotency makes
// a key unnecessary here.

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { getHttpClient } from "../http/instance.js";
import { translateHttpFailure } from "../errors/translate.js";
import { registerTool, type ToolCallContext } from "../safety/registry.js";
import { ARTIFACT_ID_PATTERN } from "../ids/formats.js";
import type { ArtifactRecord } from "./get-artifact.js";

const ARTIFACT_ID_RE = new RegExp(ARTIFACT_ID_PATTERN);

// Plan §2.7 description — verbatim. The plan text is the contract.
export const COMPLETE_UPLOAD_DESCRIPTION =
  "Finalize an artifact previously reserved via `request_upload_url` after the " +
  "bytes have been PUT to the presigned URL. Server verifies the blob, computes " +
  "the content hash, transitions the artifact from `pending` to `active`, and " +
  "increments tenant usage. Calling this on an already-active artifact is " +
  "idempotent and returns the existing record. Calling before the PUT completes " +
  "returns `upload_not_found` — wait and retry.";

export const COMPLETE_UPLOAD_TOOL: Tool = {
  name: "complete_upload",
  description: COMPLETE_UPLOAD_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      artifact_id: { type: "string", pattern: ARTIFACT_ID_PATTERN },
    },
    required: ["artifact_id"],
    additionalProperties: false,
  },
};

export const completeUploadHandler = async (
  args: Record<string, unknown> | undefined,
  ctx?: ToolCallContext
): Promise<CallToolResult> => {
  const artifactId = (args ?? {}).artifact_id;

  // The MCP SDK does not validate inputSchema before dispatch; catch a
  // non-compliant client that bypasses its own validation. The schema gate in
  // tests/qa is the primary defense.
  if (typeof artifactId !== "string" || !ARTIFACT_ID_RE.test(artifactId)) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "Bad arguments: artifact_id is required and must match ^art_[A-Za-z0-9]{16}$. Adjust the inputs and call again.",
        },
      ],
      _meta: { code: "invalid_request", status: 400, retry_hint: "do_not_retry" },
    };
  }

  const client = getHttpClient();
  const result = await client.request<ArtifactRecord>({
    method: "POST",
    path: `/v1/artifacts/${encodeURIComponent(artifactId)}/complete`,
    // idempotentWrite: 429 once, 5xx up to 3× — safe because the endpoint is
    // naturally idempotent. No Idempotency-Key injected (client gates injection
    // to POST /v1/artifacts only).
    retryPolicy: "idempotentWrite",
    requestId: ctx?.requestId,
  });

  if (result.ok) {
    return {
      content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
    };
  }
  // Pass { id } so the §6 id-bearing summaries (upload_not_found,
  // artifact_not_found, artifact_already_deleted — all reachable from this
  // endpoint per artifacts.py:397/402/416) render the artifact id.
  return translateHttpFailure(result, "complete_upload", { id: artifactId });
};

export function registerCompleteUploadTool(): void {
  // safety: "writeIdempotent" — naturally idempotent, reversible via
  // delete_artifact, default autonomous (§5.2 "✓ overridable"). The
  // ARTIFACTA_MCP_REQUIRE_WRITE_CONFIRM=1 promotion is handled by the registry
  // (complete_upload is in WRITE_CONFIRM_TOOL_NAMES). No alwaysConfirm.
  registerTool(COMPLETE_UPLOAD_TOOL, "writeIdempotent", completeUploadHandler);
}
