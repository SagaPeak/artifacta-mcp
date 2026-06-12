// store_artifact — local `path` path (streaming multipart) per AF_CLI-1.2.
//
// Every input path traverses the AF_MCP-1.6 confinement engine BEFORE the file
// is opened. checkPath() runs the deny-list and allow-list checks first and only
// then opens the fd, so a refused path is never read (AF_MCP-3.1 AC). On success
// it returns an open fd; the HTTP client streams from it (re-reading per retry),
// and this handler closes it in a `finally`.

import { closeSync } from "node:fs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getHttpClient } from "../http/instance.js";
import { translateHttpFailure } from "../errors/translate.js";
import { checkPath, MAX_PATH_UPLOAD_BYTES } from "../path/confinement.js";
import { getAllowRoots } from "../path/allowlist.js";
import type { ToolCallContext } from "../safety/registry.js";
import type { ArtifactRecord } from "./get-artifact.js";
import {
  refusalResult,
  successResult,
  type StoreArtifactArgs,
} from "./store-artifact-shared.js";

export async function storeArtifactPath(
  args: StoreArtifactArgs,
  ctx?: ToolCallContext
): Promise<CallToolResult> {
  const inputPath = args.path ?? "";

  // Confinement check FIRST. On refusal the engine returns before opening the
  // file, so the denied path is never read.
  const check = checkPath(inputPath, getAllowRoots(), MAX_PATH_UPLOAD_BYTES);
  if (!check.ok) {
    return refusalResult(check.reason);
  }

  const { fd, resolvedPath, size, mtimeMs } = check;
  try {
    const fields: Record<string, string | undefined> = {
      filename: args.filename,
      content_type: args.content_type,
      session_id: args.session_id,
      agent_id: args.agent_id,
      ttl: args.ttl,
      // The multipart API path expects metadata as a JSON string field.
      metadata: args.metadata !== undefined ? JSON.stringify(args.metadata) : undefined,
    };

    const client = getHttpClient();
    const result = await client.request<ArtifactRecord>({
      method: "POST",
      path: "/v1/artifacts",
      multipart: {
        fields,
        file: {
          fieldName: "file",
          filename: args.filename,
          // The API derives the artifact's content_type from the `content_type`
          // form field (guessing from filename when absent); the part header
          // Content-Type is not authoritative, so a generic default is fine.
          contentType: args.content_type ?? "application/octet-stream",
          fd,
          sourcePath: resolvedPath,
          size,
          mtimeMs,
        },
      },
      retryPolicy: "idempotentWrite",
      callerIdempotencyKey: args.idempotency_key,
      isUpload: true,
      requestId: ctx?.requestId,
    });

    if (result.ok) {
      return successResult(result.data, result.injectedIdempotencyKey);
    }
    return translateHttpFailure(result, "store_artifact");
  } finally {
    // The stream uses autoClose:false, so this handler owns the fd. The inner
    // try/catch guards the rare case where the fd was already closed.
    try {
      closeSync(fd);
    } catch {
      /* already closed — defensive */
    }
  }
}
