import {
  ErrorCode,
  McpError,
  type ReadResourceResult,
  type ResourceTemplate,
} from "@modelcontextprotocol/sdk/types.js";
import { fetchArtifact } from "../tools/get-artifact.js";
import { translateHttpFailure } from "../errors/translate.js";
import { registerResourceTemplate } from "./registry.js";

export const ARTIFACT_RESOURCE_TEMPLATE: ResourceTemplate = {
  uriTemplate: "artifacta://artifact/{artifact_id}",
  name: "artifact",
  description:
    "Metadata for a single artifact by ID. Same JSON shape as the `get_artifact` tool result.",
  mimeType: "application/json",
};

async function readArtifactResource(
  uri: string,
  params: Record<string, string>
): Promise<ReadResourceResult> {
  const id = params.artifact_id;
  if (!id) {
    throw new McpError(ErrorCode.InvalidParams, `Malformed URI: ${uri}`);
  }
  const r = await fetchArtifact(id);
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
  // No `isError` on resources — surface failures via McpError with the
  // translated remediation text from §6.
  const translated = translateHttpFailure(r.failure, "get_artifact");
  const text =
    translated.content[0]?.type === "text"
      ? translated.content[0].text
      : `Artifacta API error: ${r.failure.error.code}`;
  // 4xx errors (not_found / expired / deleted / unauthorized) map to
  // InvalidRequest so clients can surface them as user-actionable rather than
  // internal server faults; transport / 5xx failures fall back to InternalError.
  const isClientError =
    r.failure.status >= 400 && r.failure.status < 500;
  const code = isClientError ? ErrorCode.InvalidRequest : ErrorCode.InternalError;
  throw new McpError(code, text);
}

export function registerArtifactResource(): void {
  registerResourceTemplate(ARTIFACT_RESOURCE_TEMPLATE, readArtifactResource);
}
