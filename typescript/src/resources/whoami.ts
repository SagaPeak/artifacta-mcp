import {
  ErrorCode,
  McpError,
  type ReadResourceResult,
  type Resource,
} from "@modelcontextprotocol/sdk/types.js";
import { fetchWhoami } from "../tools/whoami.js";
import { translateHttpFailure } from "../errors/translate.js";
import { registerResource } from "./registry.js";

export const WHOAMI_RESOURCE_URI = "artifacta://whoami";

export const WHOAMI_RESOURCE: Resource = {
  uri: WHOAMI_RESOURCE_URI,
  name: "whoami",
  description:
    "Currently authenticated tenant identity, plan tier, usage counters, and rate limits. Same payload as the `whoami` tool, browsable as a stable URI.",
  mimeType: "application/json",
};

async function readWhoamiResource(uri: string): Promise<ReadResourceResult> {
  const r = await fetchWhoami();
  if (r.ok) {
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(r.data, null, 2),
        },
      ],
    };
  }
  // Resources have no `isError` shape — surface failures via McpError so the
  // client sees a structured rejection. The translated remediation text from
  // §6 / §4.3 still travels in the error message.
  const translated = translateHttpFailure(r.failure, "whoami");
  const text =
    translated.content[0]?.type === "text"
      ? translated.content[0].text
      : `Artifacta API error: ${r.failure.error.code}`;
  const code =
    r.failure.status === 401
      ? ErrorCode.InvalidRequest
      : ErrorCode.InternalError;
  throw new McpError(code, text);
}

export function registerWhoamiResource(): void {
  registerResource(WHOAMI_RESOURCE, readWhoamiResource);
}
