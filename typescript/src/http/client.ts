import { Pool } from "undici";
import { randomUUID } from "node:crypto";
import { fstatSync } from "node:fs";
import type { Config } from "../config.js";
import { VERSION } from "../server.js";
import type {
  RequestOptions,
  HttpResult,
  HttpFailure,
  BytesResult,
  ArtifactaErrorEnvelope,
  MultipartFilePart,
  MultipartIntegrity,
} from "./types.js";
import {
  shouldRetry5xx,
  wait5xx,
  wait429,
} from "./retry.js";
import { recordHttpResult } from "../escalation/tracker.js";
import { logger } from "../log/logger.js";
import { buildMultipartBody, makeBoundary } from "./multipart.js";

const CONNECT_TIMEOUT_MS = 30_000;
const READ_TIMEOUT_MS = 60_000;
const POOL_CONNECTIONS = 10;
const POOL_IDLE_TIMEOUT_MS = 30_000;

// One pool per origin, created lazily.
const pools = new Map<string, Pool>();

function getPool(origin: string): Pool {
  let pool = pools.get(origin);
  if (!pool) {
    pool = new Pool(origin, {
      connections: POOL_CONNECTIONS,
      keepAliveTimeout: POOL_IDLE_TIMEOUT_MS,
      connectTimeout: CONNECT_TIMEOUT_MS,
    });
    pools.set(origin, pool);
  }
  return pool;
}

export class ArtifactaHttpClient {
  private config: Config;
  private origin: string;
  private userAgent: string;

  constructor(config: Config) {
    this.config = config;
    const url = new URL(config.apiUrl);
    this.origin = url.origin;
    this.userAgent = `artifacta-mcp/${VERSION} (node/${process.version})`;
  }

  /** Update config (e.g., after a key change — config is fixed at start but tests swap it). */
  setConfig(config: Config): void {
    this.config = config;
    const url = new URL(config.apiUrl);
    this.origin = url.origin;
  }

  /**
   * Raw byte GET against an arbitrary URL (e.g. a presigned R2 URL), through the
   * shared per-origin connection pool (AF_MCP-1.3). Content-agnostic: returns the
   * bytes + status; the caller decides how to encode them. Sends NO Authorization
   * header — the presigned URL is self-authenticating, and leaking the Artifacta
   * bearer to R2 would be wrong. No retries (the resource read is a single-shot
   * preview path).
   *
   * Buffering note (AF_MCP-3.5 AC #5, marked untestable in the QA spec): MCP
   * `resources/read` must return COMPLETE content (a `blob`/`text` value), so the
   * bytes are necessarily materialized here. The primary oversize guard is the
   * caller's pre-fetch `size_bytes` check; a Content-Length sniff is a cheap
   * secondary guard against a response that claims a larger body than the
   * metadata. A chunked response without Content-Length that exceeds `maxBytes`
   * is the residual (bounded in practice by the caller's size gate).
   */
  async fetchBytes(url: string, maxBytes: number): Promise<BytesResult> {
    const u = new URL(url);
    const pool = getPool(u.origin);
    try {
      const resp = await pool.request({
        origin: u.origin,
        path: u.pathname + u.search,
        method: "GET",
        headers: { "User-Agent": this.userAgent },
        bodyTimeout: READ_TIMEOUT_MS,
      });
      const status = resp.statusCode;
      if (status < 200 || status >= 300) {
        await resp.body.dump();
        return { ok: false, status };
      }
      // Secondary oversize guard: refuse before reading the body into memory.
      const clHeader = resp.headers["content-length"];
      const clRaw = Array.isArray(clHeader) ? clHeader[0] : clHeader;
      if (clRaw !== undefined) {
        const contentLength = Number(clRaw);
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
          await resp.body.dump();
          return { ok: false, status, reason: "oversize" };
        }
      }
      const ab = await resp.body.arrayBuffer();
      const bytes = Buffer.from(ab);
      if (bytes.byteLength > maxBytes) {
        return { ok: false, status, reason: "oversize" };
      }
      return { ok: true, status, bytes };
    } catch {
      return { ok: false, status: 0 };
    }
  }

  async request<T = unknown>(opts: RequestOptions): Promise<HttpResult<T>> {
    const result = await this._request<T>(opts);

    // Outage tracker: only count transport-level failures (network exhausted /
    // 5xx exhausted) toward the "API unreachable" notification per plan §6.3.
    // A 4xx response means the API was reachable enough to reject our request
    // with a logical error (auth, not_found, quota, rate_limited, validation);
    // those must NOT trigger the outage notifier — they would mask the real
    // remediation (e.g. an invalid API key).
    const isReachable =
      result.ok || (result.status >= 400 && result.status < 500);
    recordHttpResult(isReachable);

    if (opts.requestId) {
      const extras: Record<string, unknown> = {
        request_id: opts.requestId,
        method: opts.method,
        path: opts.path,
        status: result.status,
        ok: result.ok,
      };
      if (result.ok) {
        logger.debug("http request completed", extras);
      } else {
        extras.code = result.error.code;
        logger.debug("http request failed", extras);
      }
    }
    return result;
  }

  private async _request<T = unknown>(opts: RequestOptions): Promise<HttpResult<T>> {
    const pool = getPool(this.origin);
    const isMultipart = opts.multipart !== undefined;
    // One boundary for the whole request, reused across retry attempts (each
    // attempt rebuilds the body stream but the boundary token can be stable).
    const boundary = isMultipart ? makeBoundary() : "";
    const headers: Record<string, string> = {
      "Content-Type": isMultipart
        ? `multipart/form-data; boundary=${boundary}`
        : "application/json",
      "User-Agent": this.userAgent,
    };

    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }

    // Auto-inject Idempotency-Key only for POST /v1/artifacts (store_artifact).
    // §6.2: never inject on upload-url, links, complete, seal, delete.
    let injectedIdempotencyKey: string | undefined;
    const isStoreArtifact =
      opts.method === "POST" && opts.path === "/v1/artifacts";

    if (isStoreArtifact) {
      injectedIdempotencyKey = opts.callerIdempotencyKey ?? `mcp_${randomUUID()}`;
      headers["Idempotency-Key"] = injectedIdempotencyKey;
    }
    // If caller explicitly provides a key for other endpoints, pass it through.
    // (Per resolved Q#6, this won't happen in v1 but the structure supports it.)

    // Multipart bodies stream from an fd with chunked transfer-encoding — no
    // precomputed Content-Length, and the body is rebuilt per attempt below.
    const bodyBytes =
      !isMultipart && opts.body !== undefined
        ? Buffer.from(JSON.stringify(opts.body))
        : undefined;
    if (bodyBytes) {
      headers["Content-Length"] = String(bodyBytes.byteLength);
    }

    let attempt = 0;
    let has429Retried = false;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Re-verify the source file BEFORE each attempt. checkPath() validated the
      // size (against the ceiling) and captured size+mtime; if the file was
      // mutated in place since then, abort with a non-retryable invalid_request
      // rather than stream unverified bytes (or, on a retry, bytes that differ
      // from the first attempt under the same Idempotency-Key). No bytes sent yet.
      if (isMultipart && multipartSourceChanged(opts.multipart!.file)) {
        return multipartDriftFailure(
          opts.multipart!.file,
          attempt,
          "size/mtime mismatch; aborting before any bytes were sent"
        );
      }

      // Fresh per-attempt integrity signal — reset so a prior attempt's tear
      // cannot bleed into this attempt. buildMultipartBody's generator sets
      // `torn` if it detects an in-read mutation (and throws to abort the stream).
      let integrity: MultipartIntegrity | undefined;
      if (isMultipart) {
        integrity = { torn: false };
        opts.multipart!.integrity = integrity;
      }

      let status = 0;
      let responseBody = "";
      let retryAfterHeaderValue: string | null = null;

      try {
        // Streaming uploads (multipart or explicit isUpload) disable the read
        // timeout — a large file PUT can exceed 60s legitimately.
        const bodyTimeout = opts.isUpload || isMultipart ? 0 : READ_TIMEOUT_MS;
        // Rebuild the multipart body fresh each attempt: the prior stream is
        // spent, but createReadStream({ fd, start: 0 }) re-reads from the top,
        // so a retry re-sends identical bytes (idempotentWrite-safe).
        const body = isMultipart
          ? buildMultipartBody(opts.multipart!, boundary)
          : bodyBytes;
        const resp = await pool.request({
          origin: this.origin,
          path: opts.path,
          method: opts.method,
          headers,
          body,
          bodyTimeout,
        });

        status = resp.statusCode;
        // Extract Retry-After header before consuming body (undici normalizes to lowercase)
        const raHeader = resp.headers["retry-after"];
        if (raHeader !== undefined) {
          retryAfterHeaderValue = Array.isArray(raHeader) ? raHeader[0] ?? null : raHeader;
        }
        responseBody = await resp.body.text();
      } catch (networkErr) {
        // Torn-read abort: the body generator detected an in-read source mutation
        // and threw before the closing boundary, so undici rejected the request.
        // The server never receives the closing delimiter, so the part is never
        // finalized and the server's missing-file guard rejects it as
        // invalid_request before any commit (see the invariant in multipart.ts).
        // Non-retryable — retrying would re-read the now-mutated file.
        if (isMultipart && integrity?.torn) {
          return multipartDriftFailure(
            opts.multipart!.file,
            attempt,
            integrity.reason ?? "torn read detected during streaming"
          );
        }
        // Network/timeout error
        const shouldRetry = shouldRetry5xx({ attempt, policy: opts.retryPolicy });
        if (shouldRetry) {
          await wait5xx(attempt);
          attempt++;
          continue;
        }
        // Network failure on non-retryable
        return {
          ok: false,
          status: 0,
          error: {
            code: "network_error",
            message:
              networkErr instanceof Error ? networkErr.message : String(networkErr),
            status: 0,
          },
          attempts: attempt + 1,
          ambiguousCompletion: opts.retryPolicy === "nonIdempotentWrite",
        };
      }

      if (status === 429) {
        if (!has429Retried) {
          has429Retried = true;
          let bodyRetryAfter: number | undefined;
          try {
            const parsed = JSON.parse(responseBody) as ArtifactaErrorEnvelope;
            bodyRetryAfter = parsed.error?.retry_after;
          } catch { /* ignore parse failure */ }
          await wait429(retryAfterHeaderValue, bodyRetryAfter);
          continue;
        }
        // Already retried 429 once — fall through to failure
      }

      if (status >= 200 && status < 300) {
        // No post-response drift check: in-read tears are caught precisely by the
        // generator (which aborts the stream before this point), so a 2xx here
        // means the validated bytes were streamed intact. A write that lands after
        // the read completed is outside the integrity window and must NOT fail an
        // already-committed upload.
        let data: T;
        try {
          data = JSON.parse(responseBody) as T;
        } catch {
          data = responseBody as unknown as T;
        }
        return {
          ok: true,
          status,
          data,
          injectedIdempotencyKey: isStoreArtifact ? injectedIdempotencyKey : undefined,
        };
      }

      if (status >= 500) {
        const shouldRetry = shouldRetry5xx({ attempt, policy: opts.retryPolicy });
        if (shouldRetry) {
          await wait5xx(attempt);
          attempt++;
          continue;
        }
        // Exhausted retries or non-retryable policy. A genuine 5xx (no in-read
        // tear — those abort the stream into the catch branch above) is a normal
        // server_error; do not reinterpret it.
        const errorEnvelope = parseErrorEnvelope(responseBody, status, "server_error");
        return {
          ok: false,
          status,
          error: errorEnvelope,
          attempts: attempt + 1,
          ambiguousCompletion: opts.retryPolicy === "nonIdempotentWrite",
        };
      }

      // 4xx (including 429 exhausted)
      const errorEnvelope = parseErrorEnvelope(responseBody, status, "http_error");
      return {
        ok: false,
        status,
        error: errorEnvelope,
        attempts: attempt + 1,
      };
    }
  }
}

/**
 * True if the multipart source file no longer matches the size/mtime that
 * checkPath() validated — i.e. it was modified in place since validation. A
 * failing fstat (fd no longer usable) is also treated as changed.
 *
 * Used ONLY for the pre-attempt check (no bytes sent yet): it catches a mutation
 * that happened BETWEEN validation and the start of an attempt, which would
 * otherwise break the byte-identical-retry guarantee. The in-read tear (mutation
 * DURING the stream) is detected separately and precisely by buildMultipartBody's
 * generator (which aborts the stream before the closing boundary). Note: only
 * in-place writes are detectable — a file replaced via rename leaves the held fd
 * on the original inode, so its bytes are unchanged and safe. Residuals (shared
 * with the generator's check): a hostile in-place rewrite that also restores size
 * AND mtime via utimes, and the single-syscall gap between the generator's
 * post-read fstat and the abort — both irreducible without staging the bytes to an
 * immutable copy before upload (deliberately not done — contradicts the streaming,
 * no-buffering design).
 */
function multipartSourceChanged(file: MultipartFilePart): boolean {
  try {
    const current = fstatSync(file.fd);
    return current.size !== file.size || current.mtimeMs !== file.mtimeMs;
  } catch {
    return true;
  }
}

/** Build the non-retryable invalid_request failure for a detected source drift.
 * `detail` has no trailing period — it flows through the invalid_request summary
 * template ("Bad arguments: {{message}}. Adjust the inputs and call again."). */
function multipartDriftFailure(
  file: MultipartFilePart,
  attempt: number,
  detail: string
): HttpFailure {
  return {
    ok: false,
    status: 400,
    error: {
      code: "invalid_request",
      message: `Source file '${file.sourcePath}' changed during upload (${detail})`,
      status: 400,
    },
    attempts: attempt + 1,
  };
}

/**
 * Decode a non-2xx response body into a guaranteed-valid error envelope.
 * The HttpFailure.error type is non-optional, but the wire response can be
 * malformed (empty body, JSON without an error field, JSON with a non-object
 * error). Fall back to a synthetic envelope tagged with `fallbackCode` so
 * downstream code (translation, retry decisions, request-id logging) can
 * always read `error.code` safely.
 */
function parseErrorEnvelope(
  responseBody: string,
  status: number,
  fallbackCode: "server_error" | "http_error"
): ArtifactaErrorEnvelope["error"] {
  const fallback: ArtifactaErrorEnvelope["error"] = {
    code: fallbackCode,
    message: `HTTP ${status}`,
    status,
  };
  try {
    const parsed = JSON.parse(responseBody) as Partial<ArtifactaErrorEnvelope>;
    const candidate = parsed?.error;
    if (
      candidate &&
      typeof candidate === "object" &&
      typeof candidate.code === "string"
    ) {
      return candidate as ArtifactaErrorEnvelope["error"];
    }
    return fallback;
  } catch {
    return fallback;
  }
}
