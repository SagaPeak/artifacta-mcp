import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, appendFileSync, openSync, closeSync, fstatSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.js";
import type { MultipartUpload } from "../src/http/types.js";

const VALID_KEY = "ak_live_abcdefghijklmnopqrstuvwxyz123456";
const BASE_URL = "https://api.artifacta.io";

const testConfig: Config = { apiKey: VALID_KEY, apiUrl: BASE_URL };

// We'll mock undici's Pool to intercept requests
// Mock factory — returns a Pool mock that can be controlled per-test
let mockRequestFn: ReturnType<typeof vi.fn>;

vi.mock("undici", () => {
  return {
    Pool: vi.fn().mockImplementation(() => ({
      request: (...args: unknown[]) => mockRequestFn(...args),
    })),
  };
});

// Helper to create a mock response
function makeResponse(statusCode: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    statusCode,
    headers,
    body: {
      text: async () => JSON.stringify(body),
    },
  };
}

async function getClient(config: Config = testConfig) {
  // Re-import each time to get fresh module after mocking
  const mod = await import(`../src/http/client.ts?t=${Date.now()}`);
  const client = new mod.ArtifactaHttpClient(config);
  return client;
}

describe("ArtifactaHttpClient", () => {
  beforeEach(async () => {
    mockRequestFn = vi.fn();
    vi.clearAllMocks();
    const tracker = await import("../src/escalation/tracker.js");
    tracker.resetOutageState();
    tracker.clearOutageNotifier();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("Auth headers", () => {
    it("injects Authorization: Bearer on every request", async () => {
      mockRequestFn.mockResolvedValueOnce(makeResponse(200, { tenant_id: "t1" }));
      const { ArtifactaHttpClient } = await import("../src/http/client.js");
      const client = new ArtifactaHttpClient(testConfig);
      await client.request({ method: "GET", path: "/v1/whoami", retryPolicy: "read" });
      expect(mockRequestFn).toHaveBeenCalledOnce();
      const callArgs = mockRequestFn.mock.calls[0][0] as { headers: Record<string, string> };
      expect(callArgs.headers["Authorization"]).toBe(`Bearer ${VALID_KEY}`);
    });

    it("injects User-Agent header on every request", async () => {
      mockRequestFn.mockResolvedValueOnce(makeResponse(200, {}));
      const { ArtifactaHttpClient } = await import("../src/http/client.js");
      const client = new ArtifactaHttpClient(testConfig);
      await client.request({ method: "GET", path: "/v1/whoami", retryPolicy: "read" });
      const callArgs = mockRequestFn.mock.calls[0][0] as { headers: Record<string, string> };
      expect(callArgs.headers["User-Agent"]).toMatch(/^artifacta-mcp\/.+ \(node\//);
    });
  });

  describe("Idempotency-Key injection", () => {
    it("auto-injects Idempotency-Key only for POST /v1/artifacts", async () => {
      mockRequestFn.mockResolvedValueOnce(makeResponse(200, { artifact_id: "art_1" }));
      const { ArtifactaHttpClient } = await import("../src/http/client.js");
      const client = new ArtifactaHttpClient(testConfig);
      const result = await client.request({
        method: "POST",
        path: "/v1/artifacts",
        retryPolicy: "idempotentWrite",
        body: {},
      });
      const callArgs = mockRequestFn.mock.calls[0][0] as { headers: Record<string, string> };
      expect(callArgs.headers["Idempotency-Key"]).toMatch(/^mcp_[0-9a-f-]{36}$/);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.injectedIdempotencyKey).toMatch(/^mcp_[0-9a-f-]{36}$/);
      }
    });

    it("does NOT inject Idempotency-Key for POST /v1/artifacts/upload-url", async () => {
      mockRequestFn.mockResolvedValueOnce(makeResponse(200, { upload_url: "https://r2.example.io" }));
      const { ArtifactaHttpClient } = await import("../src/http/client.js");
      const client = new ArtifactaHttpClient(testConfig);
      await client.request({
        method: "POST",
        path: "/v1/artifacts/upload-url",
        retryPolicy: "nonIdempotentWrite",
        body: {},
      });
      const callArgs = mockRequestFn.mock.calls[0][0] as { headers: Record<string, string> };
      expect(callArgs.headers["Idempotency-Key"]).toBeUndefined();
    });

    it("does NOT inject Idempotency-Key for POST /v1/artifacts/:id/links", async () => {
      mockRequestFn.mockResolvedValueOnce(makeResponse(200, { link_id: "lnk_1" }));
      const { ArtifactaHttpClient } = await import("../src/http/client.js");
      const client = new ArtifactaHttpClient(testConfig);
      await client.request({
        method: "POST",
        path: "/v1/artifacts/art_123/links",
        retryPolicy: "nonIdempotentWrite",
        body: {},
      });
      const callArgs = mockRequestFn.mock.calls[0][0] as { headers: Record<string, string> };
      expect(callArgs.headers["Idempotency-Key"]).toBeUndefined();
    });

    it("caller-provided idempotency key wins for store_artifact", async () => {
      mockRequestFn.mockResolvedValueOnce(makeResponse(200, { artifact_id: "art_2" }));
      const { ArtifactaHttpClient } = await import("../src/http/client.js");
      const client = new ArtifactaHttpClient(testConfig);
      await client.request({
        method: "POST",
        path: "/v1/artifacts",
        retryPolicy: "idempotentWrite",
        body: {},
        callerIdempotencyKey: "caller-supplied-key",
      });
      const callArgs = mockRequestFn.mock.calls[0][0] as { headers: Record<string, string> };
      expect(callArgs.headers["Idempotency-Key"]).toBe("caller-supplied-key");
    });

    it("injectedIdempotencyKey NOT present on non-store_artifact success", async () => {
      mockRequestFn.mockResolvedValueOnce(makeResponse(200, {}));
      const { ArtifactaHttpClient } = await import("../src/http/client.js");
      const client = new ArtifactaHttpClient(testConfig);
      const result = await client.request({ method: "GET", path: "/v1/whoami", retryPolicy: "read" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.injectedIdempotencyKey).toBeUndefined();
      }
    });
  });

  describe("Retry behavior — 429", () => {
    it("retries once on 429, then succeeds", async () => {
      vi.useFakeTimers();
      mockRequestFn
        .mockResolvedValueOnce(makeResponse(429, { error: { code: "rate_limited", message: "slow down", status: 429, retry_after: 0 } }))
        .mockResolvedValueOnce(makeResponse(200, { ok: true }));
      const { ArtifactaHttpClient } = await import("../src/http/client.js");
      const client = new ArtifactaHttpClient(testConfig);
      const promise = client.request({ method: "GET", path: "/v1/whoami", retryPolicy: "read" });
      await vi.runAllTimersAsync();
      const result = await promise;
      vi.useRealTimers();
      expect(mockRequestFn).toHaveBeenCalledTimes(2);
      expect(result.ok).toBe(true);
    });

    it("does not retry a second 429", async () => {
      vi.useFakeTimers();
      mockRequestFn
        .mockResolvedValueOnce(makeResponse(429, { error: { code: "rate_limited", message: "x", status: 429 } }))
        .mockResolvedValueOnce(makeResponse(429, { error: { code: "rate_limited", message: "x", status: 429 } }));
      const { ArtifactaHttpClient } = await import("../src/http/client.js");
      const client = new ArtifactaHttpClient(testConfig);
      const promise = client.request({ method: "GET", path: "/v1/whoami", retryPolicy: "read" });
      await vi.runAllTimersAsync();
      const result = await promise;
      vi.useRealTimers();
      expect(mockRequestFn).toHaveBeenCalledTimes(2);
      expect(result.ok).toBe(false);
    });

    it("Retry-After header is read from response and used for delay", async () => {
      vi.useFakeTimers();
      // 429 with Retry-After: 5 in the header — delay should be 5000ms
      mockRequestFn
        .mockResolvedValueOnce(
          makeResponse(
            429,
            { error: { code: "rate_limited", message: "slow down", status: 429 } },
            { "retry-after": "5" }
          )
        )
        .mockResolvedValueOnce(makeResponse(200, { ok: true }));
      const { ArtifactaHttpClient } = await import("../src/http/client.js");
      const client = new ArtifactaHttpClient(testConfig);
      const promise = client.request({ method: "GET", path: "/v1/whoami", retryPolicy: "read" });
      // Advance timers by exactly 5000ms — second call should now fire
      await vi.advanceTimersByTimeAsync(5000);
      const result = await promise;
      vi.useRealTimers();
      expect(mockRequestFn).toHaveBeenCalledTimes(2);
      expect(result.ok).toBe(true);
    });
  });

  describe("Retry behavior — 5xx", () => {
    it("read policy: retries 5xx up to 3 times then fails", async () => {
      // 3 5xx then 4th would never be called — 3 retries = 4 total attempts
      mockRequestFn
        .mockResolvedValueOnce(makeResponse(502, { error: { code: "server_error", message: "bad gateway", status: 502 } }))
        .mockResolvedValueOnce(makeResponse(502, { error: { code: "server_error", message: "bad gateway", status: 502 } }))
        .mockResolvedValueOnce(makeResponse(502, { error: { code: "server_error", message: "bad gateway", status: 502 } }))
        .mockResolvedValueOnce(makeResponse(502, { error: { code: "server_error", message: "bad gateway", status: 502 } }));
      const { ArtifactaHttpClient } = await import("../src/http/client.js");
      const client = new ArtifactaHttpClient(testConfig);
      const result = await client.request({ method: "GET", path: "/v1/whoami", retryPolicy: "read" });
      // Initial + 3 retries = 4 calls
      expect(mockRequestFn).toHaveBeenCalledTimes(4);
      expect(result.ok).toBe(false);
    });

    it("request_upload_url 502 does NOT trigger retry", async () => {
      mockRequestFn.mockResolvedValueOnce(
        makeResponse(502, { error: { code: "server_error", message: "bad gateway", status: 502 } })
      );
      const { ArtifactaHttpClient } = await import("../src/http/client.js");
      const client = new ArtifactaHttpClient(testConfig);
      const result = await client.request({
        method: "POST",
        path: "/v1/artifacts/upload-url",
        retryPolicy: "nonIdempotentWrite",
        body: {},
      });
      expect(mockRequestFn).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.ambiguousCompletion).toBe(true);
      }
    });

    it("create_download_link 502 does NOT trigger retry", async () => {
      mockRequestFn.mockResolvedValueOnce(
        makeResponse(502, { error: { code: "server_error", message: "bad gateway", status: 502 } })
      );
      const { ArtifactaHttpClient } = await import("../src/http/client.js");
      const client = new ArtifactaHttpClient(testConfig);
      const result = await client.request({
        method: "POST",
        path: "/v1/artifacts/art_123/links",
        retryPolicy: "nonIdempotentWrite",
        body: {},
      });
      expect(mockRequestFn).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.ambiguousCompletion).toBe(true);
      }
    });

    it("idempotentWrite: retries 5xx up to 3 times", async () => {
      mockRequestFn
        .mockResolvedValueOnce(makeResponse(503, { error: { code: "server_error", message: "x", status: 503 } }))
        .mockResolvedValueOnce(makeResponse(503, { error: { code: "server_error", message: "x", status: 503 } }))
        .mockResolvedValueOnce(makeResponse(503, { error: { code: "server_error", message: "x", status: 503 } }))
        .mockResolvedValueOnce(makeResponse(200, { artifact_id: "art_1" }));
      const { ArtifactaHttpClient } = await import("../src/http/client.js");
      const client = new ArtifactaHttpClient(testConfig);
      const result = await client.request({
        method: "POST",
        path: "/v1/artifacts/art_1/complete",
        retryPolicy: "idempotentWrite",
        body: {},
      });
      expect(mockRequestFn).toHaveBeenCalledTimes(4);
      expect(result.ok).toBe(true);
    });
  });

  describe("Network error handling", () => {
    it("network error on read retries up to 3x", async () => {
      const netErr = new Error("ECONNREFUSED");
      mockRequestFn
        .mockRejectedValueOnce(netErr)
        .mockRejectedValueOnce(netErr)
        .mockRejectedValueOnce(netErr)
        .mockResolvedValueOnce(makeResponse(200, {}));
      const { ArtifactaHttpClient } = await import("../src/http/client.js");
      const client = new ArtifactaHttpClient(testConfig);
      const result = await client.request({ method: "GET", path: "/v1/whoami", retryPolicy: "read" });
      expect(mockRequestFn).toHaveBeenCalledTimes(4);
      expect(result.ok).toBe(true);
    });

    it("network error on nonIdempotentWrite does NOT retry", async () => {
      mockRequestFn.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      const { ArtifactaHttpClient } = await import("../src/http/client.js");
      const client = new ArtifactaHttpClient(testConfig);
      const result = await client.request({
        method: "POST",
        path: "/v1/artifacts/upload-url",
        retryPolicy: "nonIdempotentWrite",
        body: {},
      });
      expect(mockRequestFn).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.ambiguousCompletion).toBe(true);
      }
    });
  });

  describe("4xx passthrough (no retry)", () => {
    it("404 is returned immediately without retry", async () => {
      mockRequestFn.mockResolvedValueOnce(
        makeResponse(404, { error: { code: "artifact_not_found", message: "not found", status: 404 } })
      );
      const { ArtifactaHttpClient } = await import("../src/http/client.js");
      const client = new ArtifactaHttpClient(testConfig);
      const result = await client.request({ method: "GET", path: "/v1/artifacts/art_x", retryPolicy: "read" });
      expect(mockRequestFn).toHaveBeenCalledTimes(1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("artifact_not_found");
      }
    });
  });

  // ─── Outage classification (regression: Codex finding 1) ──────────────────
  // 4xx logical failures (auth, not_found, quota, rate_limited, validation)
  // mean the API IS reachable; they must NOT count toward the §6.3 outage
  // notifier. Only transport failures (status 0 / network exhausted) and
  // exhausted 5xx do.
  describe("Outage tracker classification", () => {
    async function setup() {
      const tracker = await import("../src/escalation/tracker.js");
      const notifications: string[] = [];
      tracker.resetOutageState();
      tracker.setOutageNotifier((m) => notifications.push(m));
      const { ArtifactaHttpClient } = await import("../src/http/client.js");
      const client = new ArtifactaHttpClient(testConfig);
      return { tracker, notifications, client };
    }

    it("3 consecutive 401 unauthorized responses do NOT fire the outage notifier", async () => {
      const { notifications, client } = await setup();
      mockRequestFn.mockResolvedValue(
        makeResponse(401, { error: { code: "unauthorized", message: "bad key", status: 401 } })
      );
      for (let i = 0; i < 3; i++) {
        const r = await client.request({ method: "GET", path: "/v1/whoami", retryPolicy: "read" });
        expect(r.ok).toBe(false);
      }
      expect(notifications).toHaveLength(0);
    });

    it("3 consecutive 404 artifact_not_found responses do NOT fire the outage notifier", async () => {
      const { notifications, client } = await setup();
      mockRequestFn.mockResolvedValue(
        makeResponse(404, { error: { code: "artifact_not_found", message: "missing", status: 404 } })
      );
      for (let i = 0; i < 3; i++) {
        await client.request({ method: "GET", path: "/v1/artifacts/x", retryPolicy: "read" });
      }
      expect(notifications).toHaveLength(0);
    });

    it("3 consecutive 429 rate_limited responses (after exhaustion) do NOT fire the outage notifier", async () => {
      const { notifications, client } = await setup();
      // 429 retries once, then surfaces. We need to mock 2 responses per call.
      // The wrapper sees one final ok:false per request().
      mockRequestFn.mockResolvedValue(
        makeResponse(429, { error: { code: "rate_limited", message: "slow down", status: 429 } })
      );
      for (let i = 0; i < 3; i++) {
        await client.request({ method: "GET", path: "/v1/artifacts", retryPolicy: "read" });
      }
      expect(notifications).toHaveLength(0);
    });

    it("3 consecutive 402 quota_exceeded responses do NOT fire the outage notifier", async () => {
      const { notifications, client } = await setup();
      mockRequestFn.mockResolvedValue(
        makeResponse(402, { error: { code: "quota_exceeded", message: "limit", status: 402 } })
      );
      for (let i = 0; i < 3; i++) {
        await client.request({ method: "POST", path: "/v1/artifacts", retryPolicy: "idempotentWrite" });
      }
      expect(notifications).toHaveLength(0);
    });

    it("3 consecutive network exhaustions DO fire the outage notifier", async () => {
      const { notifications, client } = await setup();
      // nonIdempotentWrite fails fast (no retries on network error)
      mockRequestFn.mockRejectedValue(new Error("ECONNREFUSED"));
      for (let i = 0; i < 3; i++) {
        const r = await client.request({
          method: "POST",
          path: "/v1/upload-urls",
          retryPolicy: "nonIdempotentWrite",
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.status).toBe(0);
      }
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatch(/Artifacta API unreachable/);
    });

    it("3 consecutive 503 exhausted (after retries) DO fire the outage notifier", async () => {
      const { notifications, client } = await setup();
      // nonIdempotentWrite does not retry 5xx — one 503 per call is the surfaced result
      mockRequestFn.mockResolvedValue(
        makeResponse(503, { error: { code: "server_error", message: "down", status: 503 } })
      );
      for (let i = 0; i < 3; i++) {
        const r = await client.request({
          method: "POST",
          path: "/v1/links",
          retryPolicy: "nonIdempotentWrite",
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.status).toBe(503);
      }
      expect(notifications).toHaveLength(1);
    });

    it("a 4xx after 2 transport failures resets the counter (API was reachable)", async () => {
      const { notifications, client } = await setup();
      // Two network failures
      mockRequestFn.mockRejectedValueOnce(new Error("timeout"));
      mockRequestFn.mockRejectedValueOnce(new Error("timeout"));
      // Then a 401 — API reachable, counter resets
      mockRequestFn.mockResolvedValueOnce(
        makeResponse(401, { error: { code: "unauthorized", message: "x", status: 401 } })
      );
      // Then two more network failures — should NOT fire because counter reset
      mockRequestFn.mockRejectedValueOnce(new Error("timeout"));
      mockRequestFn.mockRejectedValueOnce(new Error("timeout"));

      for (let i = 0; i < 5; i++) {
        await client
          .request({ method: "POST", path: "/v1/upload-urls", retryPolicy: "nonIdempotentWrite" })
          .catch(() => undefined);
      }
      expect(notifications).toHaveLength(0);
    });

    it("malformed 4xx body with requestId set returns HttpFailure (does not throw)", async () => {
      // Regression: Codex finding 2. A degraded API returning valid JSON
      // without an `error` object would previously leave error=undefined
      // and the request-id log line would throw on result.error.code.
      const { client } = await setup();
      mockRequestFn.mockResolvedValueOnce(makeResponse(404, {})); // {} — no error key
      const result = await client.request({
        method: "GET",
        path: "/v1/artifacts/x",
        retryPolicy: "read",
        requestId: "req_test_id_4xx",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeDefined();
        expect(typeof result.error.code).toBe("string");
        expect(result.error.code).toBe("http_error");
        expect(result.error.status).toBe(404);
      }
    });

    it("malformed 5xx body with requestId set returns HttpFailure (does not throw)", async () => {
      const { client } = await setup();
      // nonIdempotentWrite to exhaust 5xx in one call
      mockRequestFn.mockResolvedValueOnce(makeResponse(503, {}));
      const result = await client.request({
        method: "POST",
        path: "/v1/upload-urls",
        retryPolicy: "nonIdempotentWrite",
        requestId: "req_test_id_5xx",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeDefined();
        expect(result.error.code).toBe("server_error");
        expect(result.error.status).toBe(503);
      }
    });

    it("non-JSON 4xx body with requestId set falls back to http_error", async () => {
      const { client } = await setup();
      // Return raw HTML / nginx error page
      const rawHtml = "<html><body>502 Bad Gateway</body></html>";
      mockRequestFn.mockResolvedValueOnce({
        statusCode: 400,
        headers: {},
        body: { text: async () => rawHtml },
      });
      const result = await client.request({
        method: "GET",
        path: "/v1/whoami",
        retryPolicy: "read",
        requestId: "req_html",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("http_error");
      }
    });

    it("4xx body with non-string error.code falls back to http_error", async () => {
      const { client } = await setup();
      // {error: {code: 42}} — code is not a string
      mockRequestFn.mockResolvedValueOnce(makeResponse(400, { error: { code: 42 } }));
      const result = await client.request({
        method: "GET",
        path: "/v1/whoami",
        retryPolicy: "read",
        requestId: "req_bad_shape",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(typeof result.error.code).toBe("string");
        expect(result.error.code).toBe("http_error");
      }
    });

    it("a 2xx success resets the counter (clears outage state)", async () => {
      const { notifications, client } = await setup();
      mockRequestFn.mockRejectedValueOnce(new Error("timeout"));
      mockRequestFn.mockRejectedValueOnce(new Error("timeout"));
      mockRequestFn.mockResolvedValueOnce(makeResponse(200, { ok: true }));
      mockRequestFn.mockRejectedValueOnce(new Error("timeout"));
      mockRequestFn.mockRejectedValueOnce(new Error("timeout"));
      for (let i = 0; i < 5; i++) {
        await client.request({
          method: "POST",
          path: "/v1/upload-urls",
          retryPolicy: "nonIdempotentWrite",
        });
      }
      expect(notifications).toHaveLength(0);
    });
  });
});

// ─── AF_MCP-3.1 — streaming multipart upload (store_artifact path branch) ──────

describe("ArtifactaHttpClient — multipart upload", () => {
  let dir: string;
  let filePath: string;
  const FILE_CONTENT = Buffer.from("multipart-payload-".repeat(2000)); // ~36 KB

  // A body-consuming mock: drains the Readable body so we can assert the bytes
  // actually streamed and that a retry re-sends identical content. (The default
  // mockRequestFn above never reads the body — fine for header/method tests, not
  // for stream verification.)
  const captured: { contentType?: string; contentLength?: string; body: Buffer; idempotency?: string }[] = [];

  async function drain(stream: NodeJS.ReadableStream | undefined): Promise<Buffer> {
    if (!stream || typeof (stream as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== "function") {
      return Buffer.alloc(0);
    }
    const chunks: Buffer[] = [];
    for await (const c of stream as AsyncIterable<Buffer>) chunks.push(c);
    return Buffer.concat(chunks);
  }

  function bodyConsumingResponder(responses: { statusCode: number; body: unknown }[]) {
    let i = 0;
    mockRequestFn.mockImplementation(async (opts: Record<string, unknown>) => {
      const headers = opts.headers as Record<string, string>;
      const body = await drain(opts.body as NodeJS.ReadableStream | undefined);
      captured.push({
        contentType: headers["Content-Type"],
        contentLength: headers["Content-Length"],
        body,
        idempotency: headers["Idempotency-Key"],
      });
      const r = responses[Math.min(i, responses.length - 1)];
      i++;
      return makeResponse(r.statusCode, r.body);
    });
  }

  function makeUpload(fd: number): MultipartUpload {
    const st = fstatSync(fd);
    return {
      fields: { filename: "payload.bin", content_type: "application/octet-stream", session_id: "sess_x" },
      file: {
        fieldName: "file",
        filename: "payload.bin",
        contentType: "application/octet-stream",
        fd,
        sourcePath: filePath,
        size: st.size,
        mtimeMs: st.mtimeMs,
      },
    };
  }

  beforeEach(() => {
    captured.length = 0;
    dir = mkdtempSync(join(tmpdir(), "mcp-client-mp-"));
    filePath = join(dir, "payload.bin");
    writeFileSync(filePath, FILE_CONTENT);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("sets multipart Content-Type with boundary and omits Content-Length", async () => {
    bodyConsumingResponder([{ statusCode: 201, body: { artifact_id: "art_1" } }]);
    const { ArtifactaHttpClient } = await import("../src/http/client.js");
    const client = new ArtifactaHttpClient(testConfig);
    const fd = openSync(filePath, "r");
    try {
      const result = await client.request({
        method: "POST",
        path: "/v1/artifacts",
        multipart: makeUpload(fd),
        retryPolicy: "idempotentWrite",
        isUpload: true,
      });
      expect(result.ok).toBe(true);
      expect(captured[0].contentType).toMatch(/^multipart\/form-data; boundary=----artifacta-mcp-[0-9a-f]{32}$/);
      expect(captured[0].contentLength).toBeUndefined();
      // The streamed body carries the raw file bytes between the form headers.
      expect(captured[0].body.includes(FILE_CONTENT)).toBe(true);
      expect(captured[0].body.toString("utf8")).toContain('name="file"; filename="payload.bin"');
    } finally {
      closeSync(fd);
    }
  });

  it("auto-injects Idempotency-Key on the multipart POST /v1/artifacts", async () => {
    bodyConsumingResponder([{ statusCode: 201, body: { artifact_id: "art_1" } }]);
    const { ArtifactaHttpClient } = await import("../src/http/client.js");
    const client = new ArtifactaHttpClient(testConfig);
    const fd = openSync(filePath, "r");
    try {
      const result = await client.request({
        method: "POST",
        path: "/v1/artifacts",
        multipart: makeUpload(fd),
        retryPolicy: "idempotentWrite",
        isUpload: true,
      });
      expect(captured[0].idempotency).toMatch(/^mcp_[0-9a-f-]{36}$/);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.injectedIdempotencyKey).toMatch(/^mcp_[0-9a-f-]{36}$/);
    } finally {
      closeSync(fd);
    }
  });

  it("aborts with invalid_request (no request sent) when the validated size is stale", async () => {
    bodyConsumingResponder([{ statusCode: 201, body: { artifact_id: "art_1" } }]);
    const { ArtifactaHttpClient } = await import("../src/http/client.js");
    const client = new ArtifactaHttpClient(testConfig);
    const fd = openSync(filePath, "r");
    try {
      const upload = makeUpload(fd);
      upload.file.size = upload.file.size + 100; // stale/wrong validated size
      const result = await client.request({
        method: "POST",
        path: "/v1/artifacts",
        multipart: upload,
        retryPolicy: "idempotentWrite",
        isUpload: true,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("invalid_request");
      expect(captured).toHaveLength(0); // integrity check fired before any send
    } finally {
      closeSync(fd);
    }
  });

  it("aborts when the source file is mutated in place after validation", async () => {
    bodyConsumingResponder([{ statusCode: 201, body: { artifact_id: "art_1" } }]);
    const { ArtifactaHttpClient } = await import("../src/http/client.js");
    const client = new ArtifactaHttpClient(testConfig);
    const fd = openSync(filePath, "r");
    try {
      const upload = makeUpload(fd); // snapshots current size + mtime
      appendFileSync(filePath, Buffer.alloc(500, 0x44)); // in-place growth → size changes
      const result = await client.request({
        method: "POST",
        path: "/v1/artifacts",
        multipart: upload,
        retryPolicy: "idempotentWrite",
        isUpload: true,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("invalid_request");
      expect(captured).toHaveLength(0);
    } finally {
      closeSync(fd);
    }
  });

  it("in-read tear: mutation DURING the stream aborts with invalid_request (nothing committed)", async () => {
    // The mutation lands WHILE the body is being consumed: the generator's
    // post-read fstat detects the drift and throws before the closing boundary,
    // so undici never receives a complete body. The mock therefore never returns
    // a 201 — pool.request rejects, and the client maps integrity.torn to a
    // non-retryable invalid_request. Proves the precise in-read detection.
    const { ArtifactaHttpClient } = await import("../src/http/client.js");
    const client = new ArtifactaHttpClient(testConfig);
    const fd = openSync(filePath, "r");
    try {
      const upload = makeUpload(fd);
      mockRequestFn.mockImplementation(async (opts: Record<string, unknown>) => {
        let mutated = false;
        // Consume the body chunk-by-chunk; mutate the source after the first
        // chunk (the preamble) so the change overlaps the file read.
        for await (const _chunk of opts.body as AsyncIterable<Buffer>) {
          if (!mutated) {
            appendFileSync(filePath, Buffer.alloc(1000, 0x46));
            mutated = true;
          }
        }
        // Unreachable: the generator throws on its post-read fstat above.
        return makeResponse(201, { artifact_id: "art_1" });
      });
      const result = await client.request({
        method: "POST",
        path: "/v1/artifacts",
        multipart: upload,
        retryPolicy: "idempotentWrite",
        isUpload: true,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("invalid_request");
        expect(result.error.message).toContain("changed during upload");
      }
    } finally {
      closeSync(fd);
    }
  });

  it("post-read mutation does NOT fail the upload (false-positive regression)", async () => {
    // The body is fully streamed (generator's post-read fstat passes, closing
    // boundary emitted), THEN the file is written. That write is outside the
    // integrity window — the streamed bytes were correct — so the 2xx must stand.
    const { ArtifactaHttpClient } = await import("../src/http/client.js");
    const client = new ArtifactaHttpClient(testConfig);
    const fd = openSync(filePath, "r");
    try {
      const upload = makeUpload(fd);
      mockRequestFn.mockImplementation(async (opts: Record<string, unknown>) => {
        await drain(opts.body as NodeJS.ReadableStream | undefined); // full body incl. epilogue
        appendFileSync(filePath, Buffer.alloc(300, 0x45)); // mutate AFTER the read completed
        return makeResponse(201, { artifact_id: "art_1" });
      });
      const result = await client.request({
        method: "POST",
        path: "/v1/artifacts",
        multipart: upload,
        retryPolicy: "idempotentWrite",
        isUpload: true,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.injectedIdempotencyKey).toMatch(/^mcp_[0-9a-f-]{36}$/);
    } finally {
      closeSync(fd);
    }
  });

  it("a post-read mutation followed by a genuine 5xx stays a server_error", async () => {
    const { ArtifactaHttpClient } = await import("../src/http/client.js");
    const client = new ArtifactaHttpClient(testConfig);
    const fd = openSync(filePath, "r");
    try {
      const upload = makeUpload(fd);
      mockRequestFn.mockImplementation(async (opts: Record<string, unknown>) => {
        await drain(opts.body as NodeJS.ReadableStream | undefined);
        appendFileSync(filePath, Buffer.alloc(300, 0x47)); // post-read, irrelevant
        return makeResponse(503, { error: { code: "server_error", message: "down", status: 503 } });
      });
      const result = await client.request({
        method: "POST",
        path: "/v1/artifacts",
        multipart: upload,
        retryPolicy: "nonIdempotentWrite",
        isUpload: true,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("server_error");
    } finally {
      closeSync(fd);
    }
  });

  it("a post-read mutation followed by a genuine network error stays network_error", async () => {
    const { ArtifactaHttpClient } = await import("../src/http/client.js");
    const client = new ArtifactaHttpClient(testConfig);
    const fd = openSync(filePath, "r");
    try {
      const upload = makeUpload(fd);
      mockRequestFn.mockImplementation(async (opts: Record<string, unknown>) => {
        await drain(opts.body as NodeJS.ReadableStream | undefined);
        appendFileSync(filePath, Buffer.alloc(300, 0x48)); // post-read, irrelevant
        throw new Error("socket hang up");
      });
      const result = await client.request({
        method: "POST",
        path: "/v1/artifacts",
        multipart: upload,
        retryPolicy: "nonIdempotentWrite",
        isUpload: true,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("network_error");
    } finally {
      closeSync(fd);
    }
  });

  it("re-sends byte-identical body across a 5xx retry (idempotentWrite)", async () => {
    bodyConsumingResponder([
      { statusCode: 503, body: { error: { code: "server_error", message: "down", status: 503 } } },
      { statusCode: 201, body: { artifact_id: "art_1" } },
    ]);
    const { ArtifactaHttpClient } = await import("../src/http/client.js");
    const client = new ArtifactaHttpClient(testConfig);
    const fd = openSync(filePath, "r");
    try {
      const result = await client.request({
        method: "POST",
        path: "/v1/artifacts",
        multipart: makeUpload(fd),
        retryPolicy: "idempotentWrite",
        isUpload: true,
      });
      expect(result.ok).toBe(true);
      expect(captured).toHaveLength(2);
      // Both attempts streamed the same bytes — the retry-safety contract.
      expect(captured[0].body.equals(captured[1].body)).toBe(true);
      // And the same idempotency key on both attempts (one auto-generated key per request).
      expect(captured[0].idempotency).toBe(captured[1].idempotency);
    } finally {
      closeSync(fd);
    }
  });
});

// AF_MCP-3.5 — fetchBytes (raw byte GET against a presigned R2 URL).
describe("ArtifactaHttpClient.fetchBytes", () => {
  function makeBytesResponse(
    statusCode: number,
    bytes: Buffer,
    headers: Record<string, string> = {}
  ) {
    return {
      statusCode,
      headers,
      body: {
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        dump: async () => {},
        text: async () => bytes.toString("utf-8"),
      },
    };
  }

  beforeEach(async () => {
    mockRequestFn = vi.fn();
    vi.clearAllMocks();
    // The prior describe's afterEach runs vi.restoreAllMocks(), which resets the
    // mocked Pool's implementation. The existing tests survive because their
    // api.artifacta.io pool was cached early; fetchBytes uses a NEW origin
    // (r2.example.io) whose pool is created fresh here, so re-establish the Pool
    // mock implementation before getPool() runs.
    const { Pool } = await import("undici");
    vi.mocked(Pool).mockImplementation(
      () =>
        ({ request: (...args: unknown[]) => mockRequestFn(...args) }) as unknown as InstanceType<
          typeof Pool
        >
    );
    const tracker = await import("../src/escalation/tracker.js");
    tracker.resetOutageState();
    tracker.clearOutageNotifier();
  });

  it("GETs the URL and returns the bytes on 2xx", async () => {
    const payload = Buffer.from([0x00, 0x01, 0xff]);
    mockRequestFn.mockResolvedValueOnce(makeBytesResponse(200, payload));
    const { ArtifactaHttpClient } = await import("../src/http/client.js");
    const client = new ArtifactaHttpClient(testConfig);
    const result = await client.fetchBytes("https://r2.example.io/blob/x?sig=z", 1024);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe(200);
      expect(result.bytes.equals(payload)).toBe(true);
    }
  });

  it("never sends an Authorization header to R2 (presigned URL is self-authenticating)", async () => {
    mockRequestFn.mockResolvedValueOnce(makeBytesResponse(200, Buffer.from("ok")));
    const { ArtifactaHttpClient } = await import("../src/http/client.js");
    const client = new ArtifactaHttpClient(testConfig);
    await client.fetchBytes("https://r2.example.io/blob/x", 1024);
    const callArgs = mockRequestFn.mock.calls[0][0] as {
      method: string;
      headers: Record<string, string>;
    };
    expect(callArgs.method).toBe("GET");
    expect(callArgs.headers["Authorization"]).toBeUndefined();
    expect(callArgs.headers["User-Agent"]).toMatch(/^artifacta-mcp\//);
  });

  it("returns ok:false with the status on a non-2xx response", async () => {
    mockRequestFn.mockResolvedValueOnce(makeBytesResponse(503, Buffer.from("unavailable")));
    const { ArtifactaHttpClient } = await import("../src/http/client.js");
    const client = new ArtifactaHttpClient(testConfig);
    const result = await client.fetchBytes("https://r2.example.io/blob/x", 1024);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(503);
  });

  it("refuses (oversize) when Content-Length exceeds maxBytes, without reading the body", async () => {
    const resp = makeBytesResponse(200, Buffer.alloc(10), { "content-length": "999999" });
    const arrayBufferSpy = vi.spyOn(resp.body, "arrayBuffer");
    mockRequestFn.mockResolvedValueOnce(resp);
    const { ArtifactaHttpClient } = await import("../src/http/client.js");
    const client = new ArtifactaHttpClient(testConfig);
    const result = await client.fetchBytes("https://r2.example.io/blob/big", 1024);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("oversize");
    expect(arrayBufferSpy).not.toHaveBeenCalled();
  });

  it("refuses (oversize) when the body itself exceeds maxBytes (no Content-Length)", async () => {
    mockRequestFn.mockResolvedValueOnce(makeBytesResponse(200, Buffer.alloc(2048)));
    const { ArtifactaHttpClient } = await import("../src/http/client.js");
    const client = new ArtifactaHttpClient(testConfig);
    const result = await client.fetchBytes("https://r2.example.io/blob/big", 1024);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("oversize");
  });

  it("returns ok:false on a network throw", async () => {
    mockRequestFn.mockRejectedValueOnce(new Error("ECONNRESET"));
    const { ArtifactaHttpClient } = await import("../src/http/client.js");
    const client = new ArtifactaHttpClient(testConfig);
    const result = await client.fetchBytes("https://r2.example.io/blob/x", 1024);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(0);
  });
});
