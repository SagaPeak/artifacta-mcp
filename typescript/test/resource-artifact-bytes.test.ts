// AF_MCP-3.5 — artifacta://artifact/{artifact_id}/bytes resource.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import {
  ARTIFACT_BYTES_RESOURCE_TEMPLATE,
  registerArtifactBytesResource,
} from "../src/resources/artifact-bytes.js";
import { registerArtifactResource } from "../src/resources/artifact.js";
import {
  clearResourceRegistry,
  listResourceTemplates,
  matchResourceTemplate,
} from "../src/resources/registry.js";
import { resetHttpClient, setHttpClient } from "../src/http/instance.js";
import type { ArtifactaHttpClient } from "../src/http/client.js";
import type { HttpResult, BytesResult } from "../src/http/types.js";

const VALID_ID = "art_AAAAAAAAAAAAAAAA";
const BYTES_URI = `artifacta://artifact/${VALID_ID}/bytes`;
const META_URI = `artifacta://artifact/${VALID_ID}`;
const DOWNLOAD_URL = "https://r2.example.io/blob/tenant_x/abc/file?X-Amz-Signature=z";

let mockRequest: ReturnType<typeof vi.fn>;
let mockFetchBytes: ReturnType<typeof vi.fn>;

function installFakeClient(): void {
  mockRequest = vi.fn();
  mockFetchBytes = vi.fn();
  const fake = {
    request: (opts: unknown) => mockRequest(opts),
    fetchBytes: (url: string, max: number) => mockFetchBytes(url, max),
    setConfig: vi.fn(),
  } as unknown as ArtifactaHttpClient;
  setHttpClient(fake);
}

/** Wire the 2-API-call happy path; caller supplies content_type / size / bytes. */
function setupHappyPath(opts: {
  contentType: string;
  sizeBytes?: number;
  bytes: Buffer;
}): void {
  const size = opts.sizeBytes ?? opts.bytes.byteLength;
  mockRequest.mockImplementation((o: { path: string }) => {
    if (o.path === `/v1/artifacts/${VALID_ID}`) {
      return Promise.resolve({
        ok: true,
        status: 200,
        data: {
          artifact_id: VALID_ID,
          filename: "file",
          content_type: opts.contentType,
          size_bytes: size,
          content_hash: "h".repeat(64),
          created_at: "2026-05-25T00:00:00+00:00",
        },
      } satisfies HttpResult);
    }
    if (o.path === `/v1/artifacts/${VALID_ID}/download-url`) {
      return Promise.resolve({
        ok: true,
        status: 200,
        data: {
          download_url: DOWNLOAD_URL,
          expires_in: 3600,
          filename: "file",
          content_type: opts.contentType,
          size_bytes: size,
        },
      } satisfies HttpResult);
    }
    return Promise.resolve({
      ok: false,
      status: 404,
      error: { code: "artifact_not_found", message: "nf", status: 404 },
      attempts: 1,
    } satisfies HttpResult);
  });
  mockFetchBytes.mockResolvedValue({
    ok: true,
    status: 200,
    bytes: opts.bytes,
  } satisfies BytesResult);
}

function readBytes(uri = BYTES_URI) {
  const m = matchResourceTemplate(uri)!;
  return m.read(uri, m.params);
}

beforeEach(() => {
  clearResourceRegistry();
  resetHttpClient();
  installFakeClient();
  registerArtifactResource(); // metadata template — coexistence invariant
  registerArtifactBytesResource();
});

afterEach(() => {
  clearResourceRegistry();
  resetHttpClient();
  vi.restoreAllMocks();
});

// ─── Template registration (AF_MCP-3.5.01) ───────────────────────────────────

describe("AF_MCP-3.5 — bytes resource template", () => {
  it("AF_MCP-3.5.01: resources/templates/list contains artifacta://artifact/{artifact_id}/bytes", () => {
    const t = listResourceTemplates().find(
      (x) => x.uriTemplate === "artifacta://artifact/{artifact_id}/bytes"
    );
    expect(t).toBeDefined();
    expect(t).toBe(ARTIFACT_BYTES_RESOURCE_TEMPLATE);
  });

  it("description documents the 100 MB ceiling and steers to get_artifact_download_url", () => {
    expect(ARTIFACT_BYTES_RESOURCE_TEMPLATE.description).toContain("100 MB");
    expect(ARTIFACT_BYTES_RESOURCE_TEMPLATE.description).toContain(
      "get_artifact_download_url"
    );
  });

  it("metadata and bytes templates coexist and resolve to their own readers", async () => {
    // metadata URI: 1 API call, no R2 fetch. bytes URI: 3-step flow with R2.
    setupHappyPath({ contentType: "application/json", bytes: Buffer.from("{}") });

    const metaMatch = matchResourceTemplate(META_URI)!;
    expect(metaMatch.params.artifact_id).toBe(VALID_ID);
    await metaMatch.read(META_URI, metaMatch.params);
    expect(mockFetchBytes).not.toHaveBeenCalled(); // metadata reader never fetches bytes

    vi.clearAllMocks();
    setupHappyPath({ contentType: "application/json", bytes: Buffer.from("{}") });
    const bytesMatch = matchResourceTemplate(BYTES_URI)!;
    expect(bytesMatch.params.artifact_id).toBe(VALID_ID);
    await bytesMatch.read(BYTES_URI, bytesMatch.params);
    expect(mockFetchBytes).toHaveBeenCalledOnce(); // bytes reader fetches bytes
  });
});

// ─── Content-type routing (AF_MCP-3.5.02–05) ─────────────────────────────────

describe("AF_MCP-3.5 — content-type routing", () => {
  it("AF_MCP-3.5.02: text/plain → text content, UTF-8 decoded", async () => {
    setupHappyPath({ contentType: "text/plain", bytes: Buffer.from("hello world", "utf-8") });
    const result = await readBytes();
    const c = result.contents[0] as Record<string, unknown>;
    expect(c.text).toBe("hello world");
    expect(c.blob).toBeUndefined();
    expect(c.mimeType).toBe("text/plain");
  });

  it("AF_MCP-3.5.03: application/octet-stream → blob content, base64-encoded", async () => {
    const raw = Buffer.from([0x00, 0x01, 0xff, 0xfe]);
    setupHappyPath({ contentType: "application/octet-stream", bytes: raw });
    const result = await readBytes();
    const c = result.contents[0] as Record<string, unknown>;
    expect(c.blob).toBe(raw.toString("base64"));
    expect(c.text).toBeUndefined();
    expect(c.mimeType).toBe("application/octet-stream");
  });

  it("AF_MCP-3.5.04: application/json → text content", async () => {
    setupHappyPath({ contentType: "application/json", bytes: Buffer.from('{"k":1}', "utf-8") });
    const result = await readBytes();
    const c = result.contents[0] as Record<string, unknown>;
    expect(c.text).toBe('{"k":1}');
    expect(JSON.parse(c.text as string)).toEqual({ k: 1 });
  });

  it("AF_MCP-3.5.05: mimeType equals the artifact content_type", async () => {
    setupHappyPath({ contentType: "image/png", bytes: Buffer.from([0x89, 0x50]) });
    const result = await readBytes();
    expect((result.contents[0] as Record<string, unknown>).mimeType).toBe("image/png");
  });

  it("mixed-case Text/Plain routes to text (case-insensitive)", async () => {
    setupHappyPath({ contentType: "Text/Plain", bytes: Buffer.from("hi", "utf-8") });
    const result = await readBytes();
    expect((result.contents[0] as Record<string, unknown>).text).toBe("hi");
  });

  it("text/plain; charset=utf-8 routes to text (ignores charset param)", async () => {
    setupHappyPath({ contentType: "text/plain; charset=utf-8", bytes: Buffer.from("hi", "utf-8") });
    const result = await readBytes();
    expect((result.contents[0] as Record<string, unknown>).text).toBe("hi");
  });

  it("application/vnd.api+json routes to text (+json suffix)", async () => {
    setupHappyPath({ contentType: "application/vnd.api+json", bytes: Buffer.from('{"a":1}', "utf-8") });
    const result = await readBytes();
    expect((result.contents[0] as Record<string, unknown>).text).toBe('{"a":1}');
  });
});

// ─── Call discipline (AF_MCP-3.5.06 / 3.5.10) ────────────────────────────────

describe("AF_MCP-3.5 — call discipline", () => {
  it("AF_MCP-3.5.06/10: exactly 2 API calls + 1 R2 GET, correct paths, no whoami", async () => {
    setupHappyPath({ contentType: "text/plain", bytes: Buffer.from("x") });
    await readBytes();

    expect(mockRequest).toHaveBeenCalledTimes(2);
    const first = mockRequest.mock.calls[0][0] as { method: string; path: string; retryPolicy: string };
    const second = mockRequest.mock.calls[1][0] as { method: string; path: string; retryPolicy: string };
    expect(first.method).toBe("GET");
    expect(first.path).toBe(`/v1/artifacts/${VALID_ID}`);
    expect(first.retryPolicy).toBe("read");
    expect(second.method).toBe("GET");
    expect(second.path).toBe(`/v1/artifacts/${VALID_ID}/download-url`);
    expect(second.retryPolicy).toBe("read");

    expect(mockFetchBytes).toHaveBeenCalledOnce();
    expect(mockFetchBytes.mock.calls[0][0]).toBe(DOWNLOAD_URL);

    // No whoami / no extra calls.
    const paths = mockRequest.mock.calls.map((c) => (c[0] as { path: string }).path);
    expect(paths).not.toContain("/v1/whoami");
  });
});

// ─── Error propagation (AF_MCP-3.5.07–09, 3.5.11) ────────────────────────────

describe("AF_MCP-3.5 — error propagation", () => {
  it("AF_MCP-3.5.07: artifact_not_found → McpError (InvalidRequest), no download-url/R2 call", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: { code: "artifact_not_found", message: "nf", status: 404 },
      attempts: 1,
    } satisfies HttpResult);
    await expect(readBytes()).rejects.toMatchObject({
      code: ErrorCode.InvalidRequest,
      message: expect.stringContaining("does not exist"),
    });
    expect(mockRequest).toHaveBeenCalledOnce(); // only get_artifact
    expect(mockFetchBytes).not.toHaveBeenCalled();
  });

  it("AF_MCP-3.5.08: artifact_expired → McpError with 'expired' text", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: false,
      status: 410,
      error: { code: "artifact_expired", message: "expired", status: 410 },
      attempts: 1,
    } satisfies HttpResult);
    await expect(readBytes()).rejects.toMatchObject({
      message: expect.stringMatching(/expired/i),
    });
  });

  it("AF_MCP-3.5.09: R2 fetch failure → McpError (InternalError)", async () => {
    setupHappyPath({ contentType: "text/plain", bytes: Buffer.from("x") });
    mockFetchBytes.mockResolvedValueOnce({ ok: false, status: 503 } satisfies BytesResult);
    await expect(readBytes()).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: expect.stringContaining("503"),
    });
  });

  it("get_artifact_download_url failure → McpError, no R2 call", async () => {
    mockRequest.mockImplementation((o: { path: string }) => {
      if (o.path === `/v1/artifacts/${VALID_ID}`) {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: {
            artifact_id: VALID_ID,
            filename: "f",
            content_type: "text/plain",
            size_bytes: 1,
            content_hash: "h".repeat(64),
            created_at: "2026-05-25T00:00:00+00:00",
          },
        } satisfies HttpResult);
      }
      return Promise.resolve({
        ok: false,
        status: 410,
        error: { code: "artifact_already_deleted", message: "gone", status: 410 },
        attempts: 1,
      } satisfies HttpResult);
    });
    await expect(readBytes()).rejects.toMatchObject({
      message: expect.stringContaining(VALID_ID),
    });
    expect(mockFetchBytes).not.toHaveBeenCalled();
  });

  it("AF_MCP-3.5.11: artifact over the 100 MB ceiling → guidance error; no download-url/R2 call", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        artifact_id: VALID_ID,
        filename: "huge.bin",
        content_type: "application/octet-stream",
        size_bytes: 100 * 1024 * 1024 + 1, // 100 MB + 1
        content_hash: "h".repeat(64),
        created_at: "2026-05-25T00:00:00+00:00",
      },
    } satisfies HttpResult);
    await expect(readBytes()).rejects.toMatchObject({
      code: ErrorCode.InvalidRequest,
      message: expect.stringContaining("get_artifact_download_url"),
    });
    expect(mockRequest).toHaveBeenCalledOnce(); // only get_artifact; gate fired before download-url
    expect(mockFetchBytes).not.toHaveBeenCalled();
  });

  it("fetchBytes 'oversize' result → guidance error pointing to get_artifact_download_url", async () => {
    setupHappyPath({ contentType: "application/octet-stream", bytes: Buffer.from("x"), sizeBytes: 1 });
    mockFetchBytes.mockResolvedValueOnce({ ok: false, status: 200, reason: "oversize" } satisfies BytesResult);
    await expect(readBytes()).rejects.toMatchObject({
      code: ErrorCode.InvalidRequest,
      message: expect.stringContaining("get_artifact_download_url"),
    });
  });

  it("malformed URI (no artifact_id param) → McpError InvalidParams", async () => {
    // Direct reader call with empty params (the regex normally guarantees a
    // non-empty segment, but the reader guards defensively).
    const m = matchResourceTemplate(BYTES_URI)!;
    await expect(m.read("artifacta://artifact//bytes", {})).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
    });
  });
});
