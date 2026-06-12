// AF_MCP-4.1 — delete_artifact tool (destructive — gated, P0).
//
// Soft-deletes an artifact. Maps to DELETE /v1/artifacts/{id}. Plan §2.9
// verbatim for description and input schema.
//
// SAFETY CLASSIFICATION: registered with `safety: "destructive"` per plan
// §5.2 ("Irreversible after 30-day grace and unrecoverable thereafter.
// Always confirm. No override."). The gating engine handles consent:
//   - Compliant clients (experimental.confirmations advertised): tool appears
//     in tools/list with `meta.requiresConfirmation: true`.
//   - Non-compliant clients (no confirmation capability): tool is OMITTED from
//     tools/list and blocked at call dispatch — unless --allow-destructive is
//     set at launch.
//   - When --allow-destructive exposes the tool to a non-compliant client,
//     server.ts emits the §5 stderr audit line per call.
// ARTIFACTA_MCP_REQUIRE_WRITE_CONFIRM has no effect (it only promotes the four
// write tools in WRITE_CONFIRM_TOOL_NAMES; destructive tools are already
// gated). --allow-destructive is read from argv only (parseSafetyFlags in
// safety/flags.ts) — never from env or TOML, by design.
//
// RETRY POLICY: "idempotentWrite" — naturally idempotent per plan §6.1. A
// second call on an already-deleted artifact returns 410 with code
// `artifact_already_deleted`, which the MCP layer treats as success-on-replay
// (synthesized success response — see DELETED_REPLAY_SHAPE below). 429 once,
// 5xx up to 3× with jitter. No Idempotency-Key injected: the client gates
// auto-injection to POST /v1/artifacts only, and natural idempotency on
// DELETE makes a key unnecessary.

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { getHttpClient } from "../http/instance.js";
import { translateHttpFailure } from "../errors/translate.js";
import { registerTool, type ToolCallContext } from "../safety/registry.js";
import { ARTIFACT_ID_PATTERN } from "../ids/formats.js";

const ARTIFACT_ID_RE = new RegExp(ARTIFACT_ID_PATTERN);

// Plan §2.9 description — verbatim.
export const DELETE_ARTIFACT_DESCRIPTION =
  "Soft-delete an artifact. The artifact disappears from listings immediately " +
  "and download URLs return `410 Gone`. Storage and the underlying R2 blob are " +
  "hard-deleted by a background job 30 days later. There is no undo from the " +
  "API — do not call without explicit user confirmation.";

export const DELETE_ARTIFACT_TOOL: Tool = {
  name: "delete_artifact",
  description: DELETE_ARTIFACT_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      artifact_id: { type: "string", pattern: ARTIFACT_ID_PATTERN },
    },
    required: ["artifact_id"],
    additionalProperties: false,
  },
};

interface DeleteArtifactResponse {
  artifact_id: string;
  deleted: true;
  deleted_at: string;
  [k: string]: unknown;
}

export const deleteArtifactHandler = async (
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
  const result = await client.request<DeleteArtifactResponse>({
    method: "DELETE",
    path: `/v1/artifacts/${encodeURIComponent(artifactId)}`,
    // idempotentWrite: 429 once, 5xx up to 3× with jitter. Safe because the
    // endpoint is naturally idempotent (replay returns 410 which we treat as
    // success below). No Idempotency-Key injected (client gates injection to
    // POST /v1/artifacts only).
    retryPolicy: "idempotentWrite",
    requestId: ctx?.requestId,
  });

  if (result.ok) {
    return {
      content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
    };
  }

  // Success-on-replay: 410 `artifact_already_deleted` means a prior call
  // already soft-deleted this artifact. Per plan §6.1 and the AF_MCP-4.1
  // scope, surface this as a success response (not isError) so the agent
  // does not falsely conclude the delete failed. The API's 410 body is the
  // error envelope (no deleted_at), so we synthesize a minimal success shape
  // carrying the input artifact_id + `already_deleted: true`. Agents that
  // want the original deletion timestamp can call get_artifact (which
  // returns artifact_already_deleted with the timestamp in some flows).
  if (
    result.status === 410 &&
    result.error.code === "artifact_already_deleted"
  ) {
    const replayBody = {
      artifact_id: artifactId,
      deleted: true,
      already_deleted: true,
    };
    return {
      content: [{ type: "text", text: JSON.stringify(replayBody, null, 2) }],
    };
  }

  // Pass { id } so the §6 id-bearing summaries (artifact_not_found,
  // artifact_already_deleted on the rare path it surfaces as an error, etc.)
  // render the artifact id.
  return translateHttpFailure(result, "delete_artifact", { id: artifactId });
};

export function registerDeleteArtifactTool(): void {
  // safety: "destructive" — the registry filters this tool from non-compliant
  // clients (unless --allow-destructive) and sets requiresConfirmation for
  // compliant clients; server.ts dispatch emits the §5 stderr audit line on
  // each call when --allow-destructive is the sole reason it's exposed.
  registerTool(DELETE_ARTIFACT_TOOL, "destructive", deleteArtifactHandler);
}
