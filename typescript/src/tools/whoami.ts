import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { getHttpClient } from "../http/instance.js";
import type { HttpFailure } from "../http/types.js";
import { translateHttpFailure } from "../errors/translate.js";
import { cacheKeySuffix } from "../whoami-cache.js";
import { registerTool } from "../safety/registry.js";

// Plan §2.1 description — verbatim. The plan text is the contract; never
// paraphrase or condense for token savings.
export const WHOAMI_DESCRIPTION =
  "Return the calling tenant's identity, plan tier, current usage counters (storage bytes, monthly requests, active links), and rate limits. Use this once at the start of an agent run to confirm authentication and to size subsequent operations against quota. Free of side effects and quota-cheap.";

export const WHOAMI_TOOL: Tool = {
  name: "whoami",
  description: WHOAMI_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
};

export interface WhoamiResponse {
  tenant_name: string;
  plan: string;
  api_key_last_4: string;
  usage_requests_month: number;
  plan_requests_limit_month: number;
  usage_storage_bytes: number;
  plan_storage_limit_bytes: number;
  active_links?: number;
  max_active_links?: number;
  rate_limit_sustained?: number;
  rate_limit_burst?: number;
  [k: string]: unknown;
}

export type WhoamiFetchResult =
  | { ok: true; data: WhoamiResponse }
  | { ok: false; failure: HttpFailure };

/**
 * Shared GET /v1/whoami fetch used by both the `whoami` tool and the
 * `artifacta://whoami` resource. On success, populates the auth-remediation
 * cache (AF_MCP-1.4) with the response's `api_key_last_4`. On failure, never
 * touches the cache — a stale suffix on a rotated key is worse than no
 * suffix at all.
 */
export async function fetchWhoami(): Promise<WhoamiFetchResult> {
  const client = getHttpClient();
  const result = await client.request<WhoamiResponse>({
    method: "GET",
    path: "/v1/whoami",
    retryPolicy: "read",
  });
  if (result.ok) {
    if (typeof result.data?.api_key_last_4 === "string") {
      cacheKeySuffix(result.data.api_key_last_4);
    }
    return { ok: true, data: result.data };
  }
  return { ok: false, failure: result };
}

export const whoamiHandler = async (): Promise<CallToolResult> => {
  const r = await fetchWhoami();
  if (r.ok) {
    return {
      content: [{ type: "text", text: JSON.stringify(r.data, null, 2) }],
    };
  }
  return translateHttpFailure(r.failure, "whoami");
};

export function registerWhoamiTool(): void {
  registerTool(WHOAMI_TOOL, "safe", whoamiHandler);
}
