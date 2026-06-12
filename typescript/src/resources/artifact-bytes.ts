// AF_MCP-3.5 — artifacta://artifact/{artifact_id}/bytes resource.
//
// The ONLY MCP surface where the server is in the data path of artifact bytes.
// resources/read flow (exactly 2 API calls + 1 R2 GET, no redundant requests):
//   1. get_artifact (fetchArtifact)        — metadata + content_type + size_bytes
//   2. size gate                           — refuse > 100 MB inline (steer to
//                                            the get_artifact_download_url tool)
//   3. get_artifact_download_url (fetchDownloadUrl) — mint the presigned R2 URL
//   4. R2 GET (client.fetchBytes)          — through the AF_MCP-1.3 pool, no auth
// Content-type routing: text/* and application/json (+ *+json) → `text` (UTF-8);
// everything else → `blob` (base64). The mimeType in the read result is the
// artifact's own content_type.

import {
  ErrorCode,
  McpError,
  type ReadResourceResult,
  type ResourceTemplate,
} from "@modelcontextprotocol/sdk/types.js";
import { fetchArtifact } from "../tools/get-artifact.js";
import { fetchDownloadUrl } from "../tools/get-artifact-download-url.js";
import { getHttpClient } from "../http/instance.js";
import type { HttpFailure } from "../http/types.js";
import { translateHttpFailure } from "../errors/translate.js";
import { registerResourceTemplate } from "./registry.js";

/** Per the task note: refuse to inline artifacts larger than this; steer the
 * agent to the get_artifact_download_url tool instead. */
const MAX_INLINE_BYTES = 100 * 1024 * 1024; // 100 MB

export const ARTIFACT_BYTES_RESOURCE_TEMPLATE: ResourceTemplate = {
  uriTemplate: "artifacta://artifact/{artifact_id}/bytes",
  name: "artifact-bytes",
  description:
    "The raw bytes of a single artifact, resolved server-side from its presigned " +
    "R2 URL, for inline display (images, text, PDFs). The MIME type is the " +
    "artifact's own content_type: text/* and application/json are returned as " +
    "text, everything else as a base64 blob. The MCP server inlines bytes up to " +
    "100 MB; for larger artifacts use the get_artifact_download_url tool to fetch " +
    "them directly from R2.",
  // Template-level hint only — the actual read sets mimeType to the artifact's
  // content_type dynamically.
  mimeType: "application/octet-stream",
};

/** text/* and application/json (incl. application/*+json) render as text; the
 * rest as a base64 blob. Case-insensitive; ignores a `; charset=…` parameter. */
function isTextContentType(contentType: string): boolean {
  const base = contentType.toLowerCase().split(";")[0].trim();
  return (
    base.startsWith("text/") ||
    base === "application/json" ||
    base.endsWith("+json")
  );
}

/** Map an Artifacta API failure to an McpError (resources have no isError shape).
 * 4xx (not_found / expired / deleted / unauthorized) → InvalidRequest so clients
 * surface them as user-actionable; transport / 5xx → InternalError. */
function failureToMcpError(
  failure: HttpFailure,
  toolName: string,
  id: string
): McpError {
  const translated = translateHttpFailure(failure, toolName, { id });
  const text =
    translated.content[0]?.type === "text"
      ? translated.content[0].text
      : `Artifacta API error: ${failure.error.code}`;
  const isClientError = failure.status >= 400 && failure.status < 500;
  return new McpError(
    isClientError ? ErrorCode.InvalidRequest : ErrorCode.InternalError,
    text
  );
}

async function readArtifactBytesResource(
  uri: string,
  params: Record<string, string>
): Promise<ReadResourceResult> {
  const id = params.artifact_id;
  if (!id) {
    throw new McpError(ErrorCode.InvalidParams, `Malformed URI: ${uri}`);
  }

  // 1. Metadata (content_type + size_bytes).
  const meta = await fetchArtifact(id);
  if (!meta.ok) {
    throw failureToMcpError(meta.failure, "get_artifact", id);
  }

  // 2. Size gate — refuse oversize BEFORE minting a URL or streaming bytes.
  const sizeBytes = meta.data.size_bytes;
  if (typeof sizeBytes === "number" && sizeBytes > MAX_INLINE_BYTES) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Artifact ${id} is ${sizeBytes} bytes, over the 100 MB inline limit for ` +
        "resource reads. Use the get_artifact_download_url tool to fetch it " +
        "directly from R2."
    );
  }

  // 3. Presigned R2 URL.
  const dl = await fetchDownloadUrl(id);
  if (!dl.ok) {
    throw failureToMcpError(dl.failure, "get_artifact_download_url", id);
  }

  // 4. Stream the bytes from R2 (no auth header; shared pool).
  const r2 = await getHttpClient().fetchBytes(dl.data.download_url, MAX_INLINE_BYTES);
  if (!r2.ok) {
    if (r2.reason === "oversize") {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Artifact ${id} exceeds the 100 MB inline limit for resource reads. ` +
          "Use the get_artifact_download_url tool to fetch it directly from R2."
      );
    }
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to fetch artifact bytes from R2 (status ${r2.status}).`
    );
  }

  // 5. content_type from the artifact metadata is authoritative.
  const contentType = meta.data.content_type;
  if (isTextContentType(contentType)) {
    return {
      contents: [
        { uri, mimeType: contentType, text: r2.bytes.toString("utf-8") },
      ],
    };
  }
  return {
    contents: [
      { uri, mimeType: contentType, blob: r2.bytes.toString("base64") },
    ],
  };
}

export function registerArtifactBytesResource(): void {
  registerResourceTemplate(ARTIFACT_BYTES_RESOURCE_TEMPLATE, readArtifactBytesResource);
}
