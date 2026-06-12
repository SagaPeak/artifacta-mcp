export interface ArtifactaErrorEnvelope {
  error: {
    code: string;
    message: string;
    status: number;
    upgrade_url?: string;
    retry_after?: number;
  };
}

export type RetryPolicy =
  | "read"               // all GET endpoints — 429 once, 5xx/network up to 3× with jitter
  | "idempotentWrite"    // POST /v1/artifacts, complete, seal, delete — same as read
  | "nonIdempotentWrite" // request_upload_url, create_download_link — 429 once, no 5xx retry
  | "never";             // reserved; non-429 4xx handled implicitly

/**
 * A single file part in a streaming multipart/form-data upload.
 *
 * The MCP server reads bytes from an already-open file descriptor (`fd`),
 * which the path-confinement engine (AF_MCP-1.6) returns *after* validating
 * the path. The fd is owned by the caller — the HTTP client streams from it
 * (possibly once per retry attempt) but never closes it. The caller closes it
 * in a `finally` after `request()` resolves.
 */
export interface MultipartFilePart {
  /** Form field name for the file part (the Artifacta API expects `"file"`). */
  fieldName: string;
  filename: string;
  contentType: string;
  /** Open, validated file descriptor from checkPath(). Caller owns + closes it. */
  fd: number;
  /** Resolved source path (passed to createReadStream for error context; the fd wins). */
  sourcePath: string;
  /**
   * Byte size validated by checkPath()'s fstat. The stream is bounded to exactly
   * this many bytes (`end: size - 1`) so a file that grows in place after the
   * check cannot bypass the size ceiling or change the bytes a retry sends.
   */
  size: number;
  /**
   * mtime (ms) from the same fstat. The HTTP client re-verifies size + mtimeMs
   * before each attempt and aborts with invalid_request if the source changed.
   */
  mtimeMs: number;
}

/**
 * Per-ATTEMPT mutable integrity signal. buildMultipartBody()'s generator sets
 * `torn = true` (with a reason) if a re-fstat taken immediately after the file
 * read — and before the closing multipart boundary — shows the source changed in
 * place during the read. The client allocates a fresh object per attempt, attaches
 * it here, and reads it in the request-rejection branch (the generator throws to
 * abort the stream, so a torn read never completes the request). Must be reset per
 * attempt so a prior attempt's tear cannot bleed into a retry's decision.
 */
export interface MultipartIntegrity {
  torn: boolean;
  reason?: string;
}

export interface MultipartUpload {
  /** Scalar form fields (filename, content_type, session_id, agent_id, ttl, metadata-as-JSON). */
  fields: Record<string, string | undefined>;
  file: MultipartFilePart;
  /** Allocated fresh per attempt by the client; mutated by buildMultipartBody. */
  integrity?: MultipartIntegrity;
}

export interface RequestOptions {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  /**
   * Streaming multipart/form-data upload. Mutually exclusive with `body`.
   * When set, the client builds a fresh request body stream per attempt so the
   * idempotentWrite retry policy can re-read the file from `file.fd`.
   */
  multipart?: MultipartUpload;
  /** Caller-provided idempotency key. When set, overrides the auto-generated key. */
  callerIdempotencyKey?: string;
  retryPolicy: RetryPolicy;
  /** Skip the read timeout for streaming upload requests. */
  isUpload?: boolean;
  /** Per-tool-call request ID; threaded through logs for cross-layer tracing. */
  requestId?: string;
}

export interface HttpSuccess<T = unknown> {
  ok: true;
  status: number;
  data: T;
  /** Injected idempotency key, present only for store_artifact requests. */
  injectedIdempotencyKey?: string;
}

export interface HttpFailure {
  ok: false;
  status: number;
  error: ArtifactaErrorEnvelope["error"];
  /** Number of retry attempts made before giving up. */
  attempts: number;
  /** True when the failure is on a non-idempotent write — signals ambiguous completion. */
  ambiguousCompletion?: boolean;
}

export type HttpResult<T = unknown> = HttpSuccess<T> | HttpFailure;

/**
 * Result of a raw byte GET against an arbitrary URL (e.g. a presigned R2 URL),
 * fetched through the shared connection pool with NO Authorization header. Used
 * by the `artifacta://artifact/{id}/bytes` resource (AF_MCP-3.5). Content-agnostic
 * — the caller decides text-vs-blob from the artifact's content_type.
 */
export type BytesResult =
  | { ok: true; status: number; bytes: Buffer }
  | { ok: false; status: number; reason?: "oversize" };
