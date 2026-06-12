// Streaming multipart/form-data body construction for store_artifact path uploads.
//
// The body is assembled as a Node Readable so large files are never fully
// buffered in memory (AF_MCP-3.1 streaming AC). Each call to buildMultipartBody
// produces a FRESH stream that re-reads the file from position 0 via a positioned
// read (`createReadStream({ fd, start: 0 })`), which is what makes the
// idempotentWrite retry policy safe: a 5xx retry rebuilds the body and re-sends
// identical bytes from the same fd. The fd is owned by the caller; the stream
// never closes it (`autoClose: false`).

import { Readable } from "node:stream";
import { createReadStream, fstatSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { MultipartUpload } from "./types.js";

const CRLF = "\r\n";

/**
 * Thrown by the multipart body generator when a re-fstat after the file read
 * shows the source changed in place during the read (a torn read). Throwing
 * before the closing boundary aborts the request, and undici surfaces the throw
 * as a request rejection the client maps to invalid_request.
 *
 * LOAD-BEARING INVARIANT (no-orphan guarantee): aborting the stream commits
 * nothing because python-multipart finalizes a form part ONLY when it reads the
 * closing delimiter `\r\n--BOUNDARY--`. Throwing before yielding the epilogue
 * means that delimiter never reaches the server, so the part is never finalized:
 * `form.get("file")` returns None and `_handle_multipart_upload`'s missing-file
 * guard raises `APIError("invalid_request", "Missing required field 'file'", 400)`
 * (rendered as a 400 by the API's exception handler) — BEFORE `_process_upload`
 * runs (no R2 put, no `artifacts` insert, no `idempotency_keys` insert). Verified empirically against python-multipart
 * 0.0.9 / 0.0.22 / 0.0.29 + Starlette 1.0.0 / 1.1.0; none synthesize a partial
 * file from an unterminated part. The risk this guards against is a future
 * parser that fabricates a file field from torn bytes (bypassing the guard) —
 * `api/pyproject.toml` pins `python-multipart>=0.0.22,<0.1.0` and
 * `api/tests/test_multipart_torn_body.py` regression-tests this behavior; keep
 * both in place.
 */
export class MultipartTornReadError extends Error {
  constructor(public readonly sourcePath: string, reason: string) {
    super(`Source file '${sourcePath}' changed during upload (${reason})`);
    this.name = "MultipartTornReadError";
  }
}

/** Generate a unique, RFC-2046-safe multipart boundary token. */
export function makeBoundary(): string {
  return `----artifacta-mcp-${randomUUID().replace(/-/g, "")}`;
}

/**
 * RFC 7578 §5.1: header field values must not contain CR/LF; the `filename`
 * parameter is a quoted-string, so embedded double-quotes and backslashes are
 * escaped. The filename is interpolated raw into the Content-Disposition header,
 * so it is sanitized here even though the schema caps its length.
 */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Build the field-name segment (no CR/LF allowed in a form-data name). */
function sanitizeFieldName(name: string): string {
  return name.replace(/[\r\n"]/g, "");
}

/**
 * Assemble the multipart preamble (all scalar fields + the file part header).
 * Returns the bytes that precede the file content on the wire.
 */
export function buildMultipartPreamble(mp: MultipartUpload, boundary: string): Buffer {
  const segments: string[] = [];
  for (const [name, value] of Object.entries(mp.fields)) {
    if (value === undefined) continue;
    segments.push(
      `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="${sanitizeFieldName(name)}"${CRLF}${CRLF}` +
        `${value}${CRLF}`
    );
  }
  const f = mp.file;
  segments.push(
    `--${boundary}${CRLF}` +
      `Content-Disposition: form-data; name="${sanitizeFieldName(f.fieldName)}"; ` +
      `filename="${sanitizeHeaderValue(f.filename)}"${CRLF}` +
      `Content-Type: ${sanitizeHeaderValue(f.contentType)}${CRLF}${CRLF}`
  );
  return Buffer.from(segments.join(""), "utf8");
}

/** The closing boundary that terminates the multipart body. */
export function buildMultipartEpilogue(boundary: string): Buffer {
  return Buffer.from(`${CRLF}--${boundary}--${CRLF}`, "utf8");
}

/**
 * Build a fresh streaming multipart/form-data body. Call once per HTTP attempt:
 * the returned Readable consumes a single positioned read of `file.fd`, so a
 * retry must rebuild it (the previous stream is spent). The fd is NOT closed by
 * this stream — the caller closes it after the request resolves.
 */
export function buildMultipartBody(mp: MultipartUpload, boundary: string): Readable {
  const preamble = buildMultipartPreamble(mp, boundary);
  const epilogue = buildMultipartEpilogue(boundary);
  const f = mp.file;

  async function* generate(): AsyncGenerator<Buffer> {
    yield preamble;
    // Bound the read to exactly the validated byte count. `end` is inclusive, so
    // a file that grew in place after checkPath() still streams only `size`
    // bytes (no size-cap bypass) and a retry re-sends identical bytes. `end: -1`
    // is invalid, so an empty file (size 0) skips the read entirely.
    if (f.size > 0) {
      const fileStream = createReadStream(f.sourcePath, {
        fd: f.fd,
        start: 0,
        end: f.size - 1,
        autoClose: false,
      });
      for await (const chunk of fileStream) {
        yield chunk as Buffer;
      }
    }
    // In-read tear detection — the precise integrity check. The validated bytes
    // have now been fully read; re-fstat the live fd and compare to the snapshot
    // checkPath() captured. A mismatch HERE means the file was overwritten in
    // place WHILE we were reading it, so the bytes already on the wire may be a
    // torn mix of old and new content. Abort by THROWING before the closing
    // boundary: the server rejects the incomplete multipart and commits nothing,
    // and undici surfaces the throw as a request rejection. This window is bounded
    // to the actual read, so a write that lands AFTER the (correct) bytes were
    // streamed is NOT a false positive (the prior post-response check was — it
    // compared the same snapshot after the whole round trip). Run unconditionally
    // (even size 0) so a write into an empty file is still caught.
    if (mp.integrity) {
      let current: ReturnType<typeof fstatSync> | undefined;
      try {
        current = fstatSync(f.fd);
      } catch {
        current = undefined;
      }
      if (!current || current.size !== f.size || current.mtimeMs !== f.mtimeMs) {
        const reason = current
          ? "modified in place during the read; the streamed bytes may be inconsistent"
          : "no longer accessible during the read";
        mp.integrity.torn = true;
        mp.integrity.reason = reason;
        throw new MultipartTornReadError(f.sourcePath, reason);
      }
    }
    yield epilogue;
  }

  return Readable.from(generate());
}
