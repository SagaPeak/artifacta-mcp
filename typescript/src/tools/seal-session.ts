// AF_MCP-4.2 — seal_session tool (destructive — gated, irreversible, P0).
//
// Permanently seals a session so no further artifacts can be added. Maps to
// POST /v1/sessions/{session_id}/seal. Plan §2.11 verbatim for the
// description (including the **bold** "irreversible" markdown emphasis) and
// the input schema.
//
// SAFETY CLASSIFICATION: registered with `safety: "destructive"` per plan
// §5.2 ("Irreversible — no `unseal` endpoint exists. Always confirm. No
// override."). Identical gating to AF_MCP-4.1 — the registry filters this
// tool from non-compliant clients (unless --allow-destructive) and sets
// requiresConfirmation for compliant clients; server.ts dispatch emits the
// §5 stderr audit line on each call when --allow-destructive is the sole
// reason it's exposed.
//
// RETRY POLICY: "idempotentWrite" — naturally idempotent per plan §6.1.
// Re-sealing an already-sealed session is a no-op that returns the existing
// seal info (the shared `seal_session` PG function sets sealed_at once and
// returns it thereafter — api/app/routers/sessions.py:114-151). 429 once,
// 5xx up to 3× with jitter. No Idempotency-Key injected (client gates
// auto-injection to POST /v1/artifacts only).
//
// SESSION_ID FORMAT DEVIATION FROM §2.11: the plan's input schema is
// {session_id: string, minLength: 1} only — no format constraint. We
// tighten it here to SESSION_ID_PATTERN (alnum start, alnum/./-/_ body,
// 1–128 chars). Rationale: FastAPI's default path converter does not
// match URL-encoded slashes, so a session_id like `run/42` (which the
// upload endpoints accept and store) cannot be sealed even after
// `encodeURIComponent` — POST /v1/sessions/run%2F42/seal is decoded to
// `/sessions/run/42/seal` before routing and returns 404. The schema
// `pattern` closes the create-then-fail-to-seal asymmetry at the MCP
// boundary; `store-artifact.ts` and `request-upload-url.ts` carry the
// matching constraint on the upload side. See SESSION_ID_PATTERN in
// `src/ids/formats.ts` for the full rationale and defence-in-depth
// backlog note.

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { getHttpClient } from "../http/instance.js";
import { translateHttpFailure } from "../errors/translate.js";
import { registerTool, type ToolCallContext } from "../safety/registry.js";
import { SESSION_ID_PATTERN, isSessionId } from "../ids/formats.js";

// Plan §2.11 description — verbatim, including the markdown **bold** on
// "irreversible". The plan text is the contract.
export const SEAL_SESSION_DESCRIPTION =
  "Permanently prevent further artifacts from being added to a session. " +
  "Existing artifacts remain readable and downloadable. Sealing a session is " +
  "**irreversible** — there is no `unseal` endpoint. Use this only when an " +
  "agent's pipeline has confirmed completion and you want to harden the " +
  "session against late-write corruption.";

export const SEAL_SESSION_TOOL: Tool = {
  name: "seal_session",
  description: SEAL_SESSION_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        minLength: 1,
        // SESSION_ID_PATTERN: alphanumeric start, alnum/./-/_ body, 1–128
        // chars. Matches the upload-side constraint in store_artifact /
        // request_upload_url so the MCP boundary cannot mint a session
        // shape the seal endpoint cannot address. See file-header note +
        // src/ids/formats.ts for the full rationale.
        pattern: SESSION_ID_PATTERN,
      },
    },
    required: ["session_id"],
    additionalProperties: false,
  },
};

interface SealSessionResponse {
  session_id: string;
  status: "sealed";
  sealed_at: string;
  artifact_count: number;
  [k: string]: unknown;
}

export const sealSessionHandler = async (
  args: Record<string, unknown> | undefined,
  ctx?: ToolCallContext
): Promise<CallToolResult> => {
  const sessionId = (args ?? {}).session_id;

  // The MCP SDK does not validate inputSchema before dispatch; catch a
  // non-compliant client that bypasses its own validation. The schema gate in
  // tests/qa is the primary defense.
  if (typeof sessionId !== "string" || !isSessionId(sessionId)) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "Bad arguments: session_id must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ (alphanumeric start; alnum, dot, underscore, hyphen body; 1–128 chars). Adjust the inputs and call again.",
        },
      ],
      _meta: { code: "invalid_request", status: 400, retry_hint: "do_not_retry" },
    };
  }

  const client = getHttpClient();
  const result = await client.request<SealSessionResponse>({
    method: "POST",
    path: `/v1/sessions/${encodeURIComponent(sessionId)}/seal`,
    // idempotentWrite: 429 once, 5xx up to 3× with jitter. Safe because the
    // endpoint is naturally idempotent (re-seal returns the existing seal
    // info). No Idempotency-Key injected.
    retryPolicy: "idempotentWrite",
    requestId: ctx?.requestId,
  });

  if (result.ok) {
    return {
      content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
    };
  }
  // Pass { id } so the §6 id-bearing summaries (session_not_found,
  // session_sealed) render the session id.
  return translateHttpFailure(result, "seal_session", { id: sessionId });
};

export function registerSealSessionTool(): void {
  // safety: "destructive" — see file-header note. Identical gating to
  // delete_artifact.
  registerTool(SEAL_SESSION_TOOL, "destructive", sealSessionHandler);
}
