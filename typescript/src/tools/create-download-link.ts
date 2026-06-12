// AF_MCP-3.4 — create_download_link tool (warn-and-cache consent, P0).
//
// Mints a stable, human-shareable dl.artifacta.io/lnk_<id> URL. Maps to
// POST /v1/artifacts/{id}/links. The input schema and description are plan §2.8
// verbatim.
//
// SAFETY CLASSIFICATION (intentional — do not "fix"): registered with
// `safety: "destructive"`, NOT `writeNonIdempotent`. Plan §5.2 lists this tool
// as "✗ (warn-and-cache)" — gated by default because its side-effect is a
// PUBLICLY accessible URL (surface area beyond the tenant boundary). The
// AF_MCP-3.4 task spec ("Note on safety classification") resolves the mechanism:
// for Phase 2 we use the destructive-gating engine because the non-compliant-
// client filtering + per-call stderr warning is exactly the consent surface we
// want. Consequences (all handled by the registry + server.ts dispatch, no code
// here): compliant clients get `meta.requiresConfirmation: true`; non-compliant
// clients don't see the tool unless `--allow-destructive`; when so exposed, every
// call emits the §5 stderr audit line. (An earlier handoff note predicted
// `writeNonIdempotent + alwaysConfirm` — superseded by the task spec.) Note:
// `WRITE_CONFIRM_TOOL_NAMES` in registry.ts still lists create_download_link;
// that membership is now redundant — destructive already forces confirmation —
// but harmless, so it's left untouched (out of scope).
//
// RETRY POLICY: "nonIdempotentWrite" — the backend does NOT honor
// `Idempotency-Key` here (§6.1/§6.2). Each call mints a new lnk_<id>, so a 5xx
// after creation but before the response could leak a second public URL on
// retry. 429 once, NEVER 5xx auto-retry; the client flags `ambiguousCompletion`
// so translateHttpFailure surfaces the §6.1 guidance (which notes there is no
// list-links API in v1 — escalate to the human if a duplicate can't be
// tolerated). No `Idempotency-Key` injected.

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { getHttpClient } from "../http/instance.js";
import { translateHttpFailure } from "../errors/translate.js";
import { registerTool, type ToolCallContext } from "../safety/registry.js";
import { ARTIFACT_ID_PATTERN } from "../ids/formats.js";

const ARTIFACT_ID_RE = new RegExp(ARTIFACT_ID_PATTERN);

// §2.8 schema bounds.
const DEFAULT_EXPIRES_IN = 604800; // 7 days
const MAX_EXPIRES_IN = 7776000; // 90 days

// Plan §2.8 description — verbatim. The plan text is the contract.
export const CREATE_DOWNLOAD_LINK_DESCRIPTION =
  "Produce a stable, human-shareable URL (`https://dl.artifacta.io/lnk_<id>`) " +
  "that resolves to the artifact bytes for a chosen duration. Use this when an " +
  "agent needs to hand off output to a human reviewer or downstream tool that " +
  "cannot inject bearer headers. Default expiry is 7 days; max is plan-dependent " +
  "(30d Free, 90d Pro). Active links are quota-limited (50 Free, 500 Pro).";

export const CREATE_DOWNLOAD_LINK_TOOL: Tool = {
  name: "create_download_link",
  description: CREATE_DOWNLOAD_LINK_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      artifact_id: { type: "string", pattern: ARTIFACT_ID_PATTERN },
      expires_in: {
        type: "integer",
        minimum: 1,
        maximum: MAX_EXPIRES_IN,
        default: DEFAULT_EXPIRES_IN,
        description: "Seconds until the link expires. 7776000 = 90 days.",
      },
    },
    required: ["artifact_id"],
    additionalProperties: false,
  },
};

interface CreateLinkBody {
  expires_in: number;
  [k: string]: unknown;
}

interface DownloadLinkResponse {
  link_id: string;
  url: string;
  artifact_id: string;
  expires_at: string;
  created_at: string;
  [k: string]: unknown;
}

export const createDownloadLinkHandler = async (
  args: Record<string, unknown> | undefined,
  ctx?: ToolCallContext
): Promise<CallToolResult> => {
  const a: Record<string, unknown> = args ?? {};
  const artifactId = a.artifact_id;

  // The MCP SDK does not validate inputSchema before dispatch; catch a
  // non-compliant client that bypasses its own validation.
  if (typeof artifactId !== "string" || !ARTIFACT_ID_RE.test(artifactId)) {
    return localInvalidRequest(
      "artifact_id is required and must match ^art_[A-Za-z0-9]{16}$"
    );
  }

  // expires_in: optional integer 1..7776000. The SDK does not apply the schema
  // default, so inject 604800 when omitted (QA AF_MCP-3.4.07: the API must be
  // called with expires_in: 604800 by default).
  let expiresIn = DEFAULT_EXPIRES_IN;
  if (a.expires_in !== undefined) {
    if (
      typeof a.expires_in !== "number" ||
      !Number.isInteger(a.expires_in) ||
      a.expires_in < 1 ||
      a.expires_in > MAX_EXPIRES_IN
    ) {
      return localInvalidRequest(
        `expires_in must be an integer from 1 to ${MAX_EXPIRES_IN} (90 days)`
      );
    }
    expiresIn = a.expires_in;
  }

  const body: CreateLinkBody = { expires_in: expiresIn };

  const client = getHttpClient();
  const result = await client.request<DownloadLinkResponse>({
    method: "POST",
    path: `/v1/artifacts/${encodeURIComponent(artifactId)}/links`,
    body,
    // nonIdempotentWrite: 429 once, NEVER 5xx auto-retry. No Idempotency-Key
    // injected (client gates injection to POST /v1/artifacts).
    retryPolicy: "nonIdempotentWrite",
    requestId: ctx?.requestId,
  });

  if (result.ok) {
    return {
      content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }],
    };
  }
  // Pass { id } so the §6 id-bearing summaries (artifact_not_found,
  // artifact_already_deleted, artifact_expired — all reachable from this
  // endpoint per artifacts.py:576/579/664) render the artifact id. On 5xx the
  // ambiguousCompletion branch takes over (no id needed there).
  return translateHttpFailure(result, "create_download_link", { id: artifactId });
};

function localInvalidRequest(message: string): CallToolResult {
  return {
    isError: true,
    content: [
      { type: "text", text: `Bad arguments: ${message}. Adjust the inputs and call again.` },
    ],
    _meta: { code: "invalid_request", status: 400, retry_hint: "do_not_retry" },
  };
}

export function registerCreateDownloadLinkTool(): void {
  // safety: "destructive" — see file-header note. The registry filters this tool
  // from non-compliant clients (unless --allow-destructive) and forces
  // requiresConfirmation for compliant clients; server.ts emits the §5 audit line
  // on each call when --allow-destructive exposed it to a non-compliant client.
  registerTool(CREATE_DOWNLOAD_LINK_TOOL, "destructive", createDownloadLinkHandler);
}
