// AF_MCP-3.1 — store_artifact tool (content + path, with confinement).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STORE_ARTIFACT_DESCRIPTION,
  STORE_ARTIFACT_TOOL,
  storeArtifactHandler,
  registerStoreArtifactTool,
} from "../src/tools/store-artifact.js";
import { resetHttpClient, setHttpClient } from "../src/http/instance.js";
import { setAllowRoots, resetAllowRoots } from "../src/path/allowlist.js";
import { clearRegistry, getToolRegistration } from "../src/safety/registry.js";
import { compileToolSchema, checkToolSchemaContract } from "./_helpers/ajv.js";
import type { ArtifactaHttpClient } from "../src/http/client.js";
import type { HttpResult } from "../src/http/types.js";

const ARTIFACT_RECORD = {
  artifact_id: "art_AAAAAAAAAAAAAAAA",
  filename: "test.txt",
  content_type: "text/plain",
  size_bytes: 11,
  content_hash: "sha256:deadbeef",
  session_id: "sess_x",
  agent_id: "agent_y",
  metadata: { env: "prod" },
  expires_at: "2026-12-31T00:00:00Z",
  created_at: "2026-04-01T00:00:00Z",
};

let mockRequest: ReturnType<typeof vi.fn>;
let tmpDirs: string[] = [];

function installFakeClient(): void {
  mockRequest = vi.fn();
  const fake = {
    request: (opts: unknown) => mockRequest(opts),
    setConfig: vi.fn(),
  } as unknown as ArtifactaHttpClient;
  setHttpClient(fake);
}

function okResult(injectedKey = "mcp_11111111-1111-1111-1111-111111111111"): HttpResult {
  return { ok: true, status: 201, data: ARTIFACT_RECORD, injectedIdempotencyKey: injectedKey };
}

function failResult(code: string, status: number, message = "boom"): HttpResult {
  return { ok: false, status, error: { code, message, status }, attempts: 1 };
}

/** Create a temp dir + file, return { dir (realpath'd), file }. */
function makeTempFile(content = "hello world"): { dir: string; file: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "mcp-store-")));
  tmpDirs.push(dir);
  const file = join(dir, "testfile.txt");
  writeFileSync(file, content);
  return { dir, file };
}

beforeEach(() => {
  clearRegistry();
  resetHttpClient();
  resetAllowRoots();
  installFakeClient();
  registerStoreArtifactTool();
});

afterEach(() => {
  clearRegistry();
  resetHttpClient();
  resetAllowRoots();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
  vi.restoreAllMocks();
});

// ─── Registration + schema ────────────────────────────────────────────────────

describe("AF_MCP-3.1 — registration", () => {
  it("registers 'store_artifact' with safety 'writeIdempotent'", () => {
    const reg = getToolRegistration("store_artifact");
    expect(reg).toBeDefined();
    expect(reg!.tool.name).toBe("store_artifact");
    expect(reg!.safety).toBe("writeIdempotent");
    expect(reg!.alwaysConfirm).toBe(false);
  });

  it("input schema satisfies the structural MCP contract", () => {
    expect(checkToolSchemaContract(STORE_ARTIFACT_TOOL)).toEqual([]);
  });

  it("schema requires filename and pins the §2.5 oneOf / metadata regex", () => {
    const s = STORE_ARTIFACT_TOOL.inputSchema as Record<string, unknown>;
    expect(s.required).toEqual(["filename"]);
    expect(s.oneOf).toEqual([{ required: ["content"] }, { required: ["path"] }]);
    expect(s.additionalProperties).toBe(false);
    const props = s.properties as Record<string, Record<string, unknown>>;
    expect(props.content.contentEncoding).toBe("base64");
    expect(props.idempotency_key.maxLength).toBe(256);
    const meta = props.metadata as Record<string, Record<string, unknown>>;
    expect(Object.keys(meta.patternProperties)[0]).toBe("^[a-zA-Z][a-zA-Z0-9_-]{0,63}$");
  });
});

describe("AF_MCP-3.1 — schema validation (Ajv)", () => {
  const validate = () => compileToolSchema(STORE_ARTIFACT_TOOL);

  it("3.1.01-shape — content-only is valid", () => {
    expect(validate()({ filename: "f", content: "eHg=" })).toBe(true);
  });
  it("3.1.05-shape — path-only is valid", () => {
    expect(validate()({ filename: "f", path: "/tmp/x" })).toBe(true);
  });
  it("3.1.08 — both content and path violates oneOf", () => {
    expect(validate()({ filename: "f", content: "eHg=", path: "/tmp/x" })).toBe(false);
  });
  it("3.1.09 — neither content nor path violates oneOf", () => {
    expect(validate()({ filename: "f" })).toBe(false);
  });
  it("3.1.18 — metadata key with leading digit rejected", () => {
    expect(validate()({ filename: "f", content: "eHg=", metadata: { "1invalid": "v" } })).toBe(false);
  });
  it("3.1.18 — metadata key with a dot rejected", () => {
    expect(validate()({ filename: "f", content: "eHg=", metadata: { "a.b": "v" } })).toBe(false);
  });
  it("3.1.19 — extra top-level property rejected", () => {
    expect(validate()({ filename: "f", content: "eHg=", surprise: 1 })).toBe(false);
  });
});

// ─── content branch ───────────────────────────────────────────────────────────

describe("AF_MCP-3.1 — content branch", () => {
  it("3.1.01 — stores via inline content; returns the artifact record", async () => {
    mockRequest.mockResolvedValueOnce(okResult());
    const res = await storeArtifactHandler({
      filename: "test.txt",
      content: Buffer.from("hello world").toString("base64"),
      content_type: "text/plain",
    });
    expect(res.isError).toBeUndefined();
    expect(mockRequest).toHaveBeenCalledOnce();
    const text = (res.content as Array<{ text: string }>)[0].text;
    expect(JSON.parse(text).artifact_id).toBe("art_AAAAAAAAAAAAAAAA");
  });

  it("3.1.01 — JSON body carries content_encoding:base64 and metadata as an object", async () => {
    mockRequest.mockResolvedValueOnce(okResult());
    await storeArtifactHandler({
      filename: "test.txt",
      content: Buffer.from("x").toString("base64"),
      metadata: { env: "prod" },
      session_id: "sess_x",
      ttl: "7d",
    });
    const opts = mockRequest.mock.calls[0][0];
    expect(opts.method).toBe("POST");
    expect(opts.path).toBe("/v1/artifacts");
    expect(opts.retryPolicy).toBe("idempotentWrite");
    expect(opts.body.content_encoding).toBe("base64");
    expect(opts.body.metadata).toEqual({ env: "prod" });
    expect(opts.body.session_id).toBe("sess_x");
    expect(opts.body.ttl).toBe("7d");
    expect(opts.multipart).toBeUndefined();
  });

  it("3.1.03 — content decoding exactly at the 10 MB ceiling is accepted", async () => {
    mockRequest.mockResolvedValueOnce(okResult());
    const tenMb = Buffer.alloc(10 * 1024 * 1024).toString("base64");
    const res = await storeArtifactHandler({ filename: "big.bin", content: tenMb });
    expect(res.isError).toBeUndefined();
    expect(mockRequest).toHaveBeenCalledOnce();
  });

  it("3.1.04 — content over 10 MB is rejected before any API call", async () => {
    const overMb = Buffer.alloc(10 * 1024 * 1024 + 1).toString("base64");
    const res = await storeArtifactHandler({ filename: "big.bin", content: overMb });
    expect(res.isError).toBe(true);
    expect((res._meta as { code: string }).code).toBe("invalid_request");
    expect(mockRequest).not.toHaveBeenCalled();
  });
});

// ─── path branch ──────────────────────────────────────────────────────────────

describe("AF_MCP-3.1 — path branch", () => {
  it("3.1.05 — stores a file inside the allow-list via streaming multipart", async () => {
    const { dir, file } = makeTempFile("hello world");
    setAllowRoots([dir]);
    mockRequest.mockResolvedValueOnce(okResult());
    const res = await storeArtifactHandler({
      filename: "test.txt",
      path: file,
      content_type: "text/plain",
      metadata: { env: "prod" },
    });
    expect(res.isError).toBeUndefined();
    const opts = mockRequest.mock.calls[0][0];
    expect(opts.path).toBe("/v1/artifacts");
    expect(opts.retryPolicy).toBe("idempotentWrite");
    expect(opts.body).toBeUndefined();
    expect(opts.multipart).toBeDefined();
    expect(opts.multipart.file.fieldName).toBe("file");
    expect(typeof opts.multipart.file.fd).toBe("number");
    // metadata is forwarded as a JSON string on the multipart path
    expect(opts.multipart.fields.metadata).toBe(JSON.stringify({ env: "prod" }));
    expect(opts.multipart.fields.filename).toBe("test.txt");
  });

  it("3.1.06 — /etc/passwd is denied; the API is never called", async () => {
    const { dir } = makeTempFile();
    setAllowRoots([dir]);
    const res = await storeArtifactHandler({
      filename: "p",
      path: "/etc/passwd",
      content_type: "text/plain",
    });
    expect(res.isError).toBe(true);
    expect((res._meta as { code: string }).code).toBe("invalid_request");
    const text = (res.content as Array<{ text: string }>)[0].text;
    // §4.4 refusal payload names the rule that fired (deny-list or allow-list).
    expect(text).toMatch(/deny-list|allow-list|outside/i);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("denial — a file outside the allow-list is refused and never sent", async () => {
    const allowed = makeTempFile().dir;
    const other = makeTempFile("secret"); // different dir, not allow-listed
    setAllowRoots([allowed]);
    const res = await storeArtifactHandler({
      filename: "x",
      path: other.file,
      content_type: "text/plain",
    });
    expect(res.isError).toBe(true);
    expect((res._meta as { code: string }).code).toBe("invalid_request");
    expect(mockRequest).not.toHaveBeenCalled();
  });
});

// ─── oneOf runtime guard (SDK does not validate before dispatch) ───────────────

describe("AF_MCP-3.1 — runtime oneOf guard", () => {
  it("3.1.08 — both content and path → invalid_request, API not called", async () => {
    const res = await storeArtifactHandler({ filename: "f", content: "eHg=", path: "/tmp/x" });
    expect(res.isError).toBe(true);
    expect((res._meta as { code: string }).code).toBe("invalid_request");
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("3.1.09 — neither content nor path → invalid_request, API not called", async () => {
    const res = await storeArtifactHandler({ filename: "f" });
    expect(res.isError).toBe(true);
    expect((res._meta as { code: string }).code).toBe("invalid_request");
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("missing filename → invalid_request, API not called", async () => {
    const res = await storeArtifactHandler({ content: "eHg=" });
    expect(res.isError).toBe(true);
    expect((res._meta as { code: string }).code).toBe("invalid_request");
    expect(mockRequest).not.toHaveBeenCalled();
  });
});

// ─── idempotency ──────────────────────────────────────────────────────────────

describe("AF_MCP-3.1 — idempotency", () => {
  it("3.1.11 — caller-supplied idempotency_key is forwarded to the client", async () => {
    mockRequest.mockResolvedValueOnce(okResult("my-key"));
    await storeArtifactHandler({
      filename: "f",
      content: Buffer.from("x").toString("base64"),
      idempotency_key: "my-key",
    });
    expect(mockRequest.mock.calls[0][0].callerIdempotencyKey).toBe("my-key");
  });

  it("3.1.14 — _meta.idempotency_key is surfaced on success", async () => {
    mockRequest.mockResolvedValueOnce(okResult("mcp_22222222-2222-2222-2222-222222222222"));
    const res = await storeArtifactHandler({
      filename: "f",
      content: Buffer.from("x").toString("base64"),
    });
    expect((res._meta as { idempotency_key: string }).idempotency_key).toBe(
      "mcp_22222222-2222-2222-2222-222222222222"
    );
  });
});

// ─── error translation ────────────────────────────────────────────────────────

describe("AF_MCP-3.1 — error translation", () => {
  const cases: Array<[string, string, number]> = [
    ["3.1.15", "quota_exceeded", 403],
    ["3.1.16", "session_sealed", 409],
    ["3.1.17", "file_too_large", 413],
    ["ttl", "ttl_exceeds_plan_limit", 400],
  ];
  for (const [id, code, status] of cases) {
    it(`${id} — ${code} translates with _meta.code`, async () => {
      mockRequest.mockResolvedValueOnce(failResult(code, status));
      const res = await storeArtifactHandler({
        filename: "f",
        content: Buffer.from("x").toString("base64"),
      });
      expect(res.isError).toBe(true);
      expect((res._meta as { code: string }).code).toBe(code);
    });
  }

  it("a torn-read invalid_request from the HTTP layer surfaces with _meta.code invalid_request", async () => {
    // The path branch aborts a torn upload as an HttpFailure(invalid_request);
    // confirm it flows through translateHttpFailure to the agent unchanged.
    mockRequest.mockResolvedValueOnce(
      failResult("invalid_request", 400, "Source file '/x' changed during upload (torn read)")
    );
    const res = await storeArtifactHandler({
      filename: "f",
      content: Buffer.from("x").toString("base64"),
    });
    expect(res.isError).toBe(true);
    expect((res._meta as { code: string }).code).toBe("invalid_request");
  });
});

// ─── runtime field validation (hardening — SDK does not validate before dispatch) ─

describe("AF_MCP-3.1 — runtime field validation", () => {
  async function expectInvalidNoCall(args: Record<string, unknown>): Promise<void> {
    const res = await storeArtifactHandler(args);
    expect(res.isError).toBe(true);
    expect((res._meta as { code: string }).code).toBe("invalid_request");
    expect(mockRequest).not.toHaveBeenCalled();
  }

  it("non-string content → invalid_request, no API call (no Buffer.from crash)", async () => {
    await expectInvalidNoCall({ filename: "f", content: 123 });
  });

  it("non-string path → invalid_request, no API call (no checkPath crash)", async () => {
    setAllowRoots(["/tmp"]);
    await expectInvalidNoCall({ filename: "f", path: 123 });
  });

  it("non-string idempotency_key → invalid_request, no API call", async () => {
    await expectInvalidNoCall({ filename: "f", content: "eHg=", idempotency_key: 123 });
  });

  it("idempotency_key over 256 chars → invalid_request", async () => {
    await expectInvalidNoCall({ filename: "f", content: "eHg=", idempotency_key: "x".repeat(257) });
  });

  it("non-object metadata → invalid_request", async () => {
    await expectInvalidNoCall({ filename: "f", content: "eHg=", metadata: "not-an-object" });
  });

  it("metadata with a non-string value → invalid_request", async () => {
    await expectInvalidNoCall({ filename: "f", content: "eHg=", metadata: { env: 123 } });
  });

  it("metadata with an invalid key → invalid_request", async () => {
    await expectInvalidNoCall({ filename: "f", content: "eHg=", metadata: { "1bad": "v" } });
  });

  it("filename over 255 chars → invalid_request", async () => {
    await expectInvalidNoCall({ filename: "x".repeat(256), content: "eHg=" });
  });

  it("non-string content_type → invalid_request", async () => {
    await expectInvalidNoCall({ filename: "f", content: "eHg=", content_type: 7 });
  });

  // SESSION_ID_PATTERN regression — Codex finding 2026-05-27.
  // The MCP server must not mint a session shape that seal_session cannot
  // address. See src/ids/formats.ts for the full rationale.
  it("session_id with slash → invalid_request, API not called (Codex finding)", async () => {
    await expectInvalidNoCall({ filename: "f", content: "eHg=", session_id: "run/42" });
  });

  it("session_id with space → invalid_request, API not called", async () => {
    await expectInvalidNoCall({ filename: "f", content: "eHg=", session_id: "run 42" });
  });

  it("session_id with leading dot → invalid_request, API not called", async () => {
    await expectInvalidNoCall({ filename: "f", content: "eHg=", session_id: ".hidden" });
  });

  it("session_id over 128 chars → invalid_request, API not called", async () => {
    await expectInvalidNoCall({ filename: "f", content: "eHg=", session_id: "a".repeat(129) });
  });

  it("session_id with Unicode → invalid_request, API not called", async () => {
    await expectInvalidNoCall({ filename: "f", content: "eHg=", session_id: "run🔥" });
  });
});

// ─── SESSION_ID_PATTERN schema gate (Codex finding regression) ────────────────

describe("AF_MCP-3.1 — session_id schema gate", () => {
  const accepted = [
    "pipeline_run_42",
    "daily_batch_20260313",
    "experiment-v3",
    "ses_abc123def456",
    "a",
    "A".repeat(128),
  ];
  const rejected = ["run/42", "run 42", ".hidden", "-leading", "_leading", "run🔥", "A".repeat(129)];

  it.each(accepted)("schema accepts session_id %s", (s) => {
    const validate = compileToolSchema(STORE_ARTIFACT_TOOL);
    expect(validate({ filename: "f", content: "eHg=", session_id: s })).toBe(true);
  });

  it.each(rejected)("schema rejects session_id %s", (s) => {
    const validate = compileToolSchema(STORE_ARTIFACT_TOOL);
    expect(validate({ filename: "f", content: "eHg=", session_id: s })).toBe(false);
  });
});

// ─── description ──────────────────────────────────────────────────────────────

describe("AF_MCP-3.1 — description", () => {
  it("3.1.20 — includes the path-confinement note", () => {
    expect(STORE_ARTIFACT_TOOL.description).toBe(STORE_ARTIFACT_DESCRIPTION);
    expect(STORE_ARTIFACT_DESCRIPTION).toContain("confined");
    expect(STORE_ARTIFACT_DESCRIPTION).toContain("allow-list");
  });

  it("3.1.21 — includes the crash-safe idempotency_key guidance", () => {
    expect(STORE_ARTIFACT_DESCRIPTION).toContain(
      "crash-safe retries, supply your own `idempotency_key`"
    );
  });

  it("steers files over 500 MB to request_upload_url (scope-boundary wording)", () => {
    expect(STORE_ARTIFACT_DESCRIPTION).toContain("request_upload_url");
    expect(STORE_ARTIFACT_DESCRIPTION).toContain("file_too_large");
  });
});
