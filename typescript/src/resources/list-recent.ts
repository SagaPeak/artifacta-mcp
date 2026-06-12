import type { Resource } from "@modelcontextprotocol/sdk/types.js";
import { getHttpClient } from "../http/instance.js";
import type { ListArtifactsResponse } from "../tools/list-artifacts.js";

const RECENT_LIMIT = 20;

interface ArtifactSummary {
  artifact_id?: string;
  filename?: string;
  [k: string]: unknown;
}

/**
 * Phase-4 resources/list enumeration of the most recent N=20 artifacts.
 *
 * Per plan §3 + AF_MCP-2.3 AC, this calls `GET /v1/artifacts?limit=20` at
 * each list-time (no in-process caching beyond the request scope). If the
 * call fails — auth, network, etc. — return an empty array so the static
 * resources (e.g. `artifacta://whoami`) still surface; a transient API
 * outage shouldn't break `resources/list`.
 */
export async function fetchRecentArtifactResources(): Promise<Resource[]> {
  let result;
  try {
    result = await getHttpClient().request<ListArtifactsResponse>({
      method: "GET",
      path: `/v1/artifacts?limit=${RECENT_LIMIT}`,
      retryPolicy: "read",
    });
  } catch {
    return [];
  }
  if (!result.ok) return [];
  const list = (result.data?.artifacts ?? []) as ArtifactSummary[];
  return list
    .filter((a) => typeof a.artifact_id === "string")
    .map((a) => ({
      uri: `artifacta://artifact/${a.artifact_id}`,
      name: typeof a.filename === "string" ? a.filename : a.artifact_id!,
      mimeType: "application/json",
    }));
}
