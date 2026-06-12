// store_artifact — inline `content` path (JSON + base64) per AF_CLI-1.2.
//
// The base64 string is decoded in-process only to enforce the 10 MB decoded
// ceiling BEFORE the API call (AF_MCP-3.1 AC). The original base64 string is
// forwarded verbatim in the JSON body with `content_encoding: "base64"`, which
// the API (`_handle_json_upload`, artifacts.py) requires.

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getHttpClient } from "../http/instance.js";
import { translateHttpFailure } from "../errors/translate.js";
import type { ToolCallContext } from "../safety/registry.js";
import type { ArtifactRecord } from "./get-artifact.js";
import {
  MAX_CONTENT_DECODED_BYTES,
  localInvalidRequest,
  successResult,
  type StoreArtifactArgs,
} from "./store-artifact-shared.js";

interface JsonUploadBody {
  filename: string;
  content: string;
  content_encoding: "base64";
  content_type?: string;
  session_id?: string;
  agent_id?: string;
  metadata?: Record<string, string>;
  ttl?: string;
  [k: string]: unknown;
}

export async function storeArtifactContent(
  args: StoreArtifactArgs,
  ctx?: ToolCallContext
): Promise<CallToolResult> {
  const content = args.content ?? "";

  // Decode to measure the real byte size. Buffer.from(base64) is lenient and
  // never throws, so this validates nothing about base64 well-formedness (the
  // API does that) — it exists solely to enforce the 10 MB ceiling before send.
  const decodedBytes = Buffer.from(content, "base64").byteLength;
  if (decodedBytes > MAX_CONTENT_DECODED_BYTES) {
    return localInvalidRequest(
      `Decoded \`content\` is ${decodedBytes} bytes, over the 10 MB inline limit; ` +
        "use `path` to stream a local file, or `request_upload_url` for files over 500 MB"
    );
  }

  const body: JsonUploadBody = {
    filename: args.filename,
    content,
    content_encoding: "base64",
  };
  if (args.content_type !== undefined) body.content_type = args.content_type;
  if (args.session_id !== undefined) body.session_id = args.session_id;
  if (args.agent_id !== undefined) body.agent_id = args.agent_id;
  if (args.metadata !== undefined) body.metadata = args.metadata;
  if (args.ttl !== undefined) body.ttl = args.ttl;

  const client = getHttpClient();
  const result = await client.request<ArtifactRecord>({
    method: "POST",
    path: "/v1/artifacts",
    body,
    retryPolicy: "idempotentWrite",
    callerIdempotencyKey: args.idempotency_key,
    requestId: ctx?.requestId,
  });

  if (result.ok) {
    return successResult(result.data, result.injectedIdempotencyKey);
  }
  return translateHttpFailure(result, "store_artifact");
}
