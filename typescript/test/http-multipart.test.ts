// AF_MCP-3.1 — streaming multipart body construction + retry-safety invariant.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, appendFileSync, openSync, closeSync, fstatSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeBoundary,
  buildMultipartPreamble,
  buildMultipartEpilogue,
  buildMultipartBody,
  MultipartTornReadError,
} from "../src/http/multipart.js";
import type { MultipartUpload } from "../src/http/types.js";

let dir: string;
let filePath: string;
const FILE_CONTENT = Buffer.from("hello-multipart-".repeat(5000)); // ~80 KB

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-mp-"));
  filePath = join(dir, "payload.bin");
  writeFileSync(filePath, FILE_CONTENT);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function makeUpload(fd: number, fields: Record<string, string | undefined> = {}): MultipartUpload {
  const st = fstatSync(fd);
  return {
    fields: { filename: "payload.bin", content_type: "application/octet-stream", ...fields },
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

describe("AF_MCP-3.1 — multipart boundary", () => {
  it("generates a unique, token-safe boundary each call", () => {
    const b1 = makeBoundary();
    const b2 = makeBoundary();
    expect(b1).not.toBe(b2);
    expect(b1).toMatch(/^----artifacta-mcp-[0-9a-f]{32}$/);
  });
});

describe("AF_MCP-3.1 — multipart preamble", () => {
  it("emits one part per defined field and skips undefined fields", () => {
    const fd = openSync(filePath, "r");
    try {
      const boundary = makeBoundary();
      const upload = makeUpload(fd, { session_id: "sess_1", agent_id: undefined });
      const preamble = buildMultipartPreamble(upload, boundary).toString("utf8");
      expect(preamble).toContain(`--${boundary}\r\n`);
      expect(preamble).toContain('Content-Disposition: form-data; name="filename"');
      expect(preamble).toContain('Content-Disposition: form-data; name="session_id"');
      expect(preamble).toContain("sess_1");
      // undefined agent_id must not appear as a part
      expect(preamble).not.toContain('name="agent_id"');
      // file part header with filename + Content-Type
      expect(preamble).toContain('name="file"; filename="payload.bin"');
      expect(preamble).toContain("Content-Type: application/octet-stream");
    } finally {
      closeSync(fd);
    }
  });

  it("sanitizes CR/LF and quotes in the filename header (RFC 7578)", () => {
    const fd = openSync(filePath, "r");
    try {
      const boundary = makeBoundary();
      const st = fstatSync(fd);
      const upload: MultipartUpload = {
        fields: {},
        file: {
          fieldName: "file",
          filename: 'evil"\r\nX-Injected: 1.bin',
          contentType: "text/plain",
          fd,
          sourcePath: filePath,
          size: st.size,
          mtimeMs: st.mtimeMs,
        },
      };
      const preamble = buildMultipartPreamble(upload, boundary).toString("utf8");
      // The injected header line must not survive as its own CRLF-delimited line
      expect(preamble).not.toContain("\r\nX-Injected: 1.bin");
      expect(preamble).toContain('filename="evil\\"  X-Injected: 1.bin"');
    } finally {
      closeSync(fd);
    }
  });
});

describe("AF_MCP-3.1 — multipart body streaming + retry-safety", () => {
  it("streams the full file content between the part header and closing boundary", async () => {
    const fd = openSync(filePath, "r");
    try {
      const boundary = makeBoundary();
      const upload = makeUpload(fd);
      const body = await drain(buildMultipartBody(upload, boundary));
      const epilogue = buildMultipartEpilogue(boundary);
      // Body must contain the raw file bytes and end with the closing boundary.
      expect(body.includes(FILE_CONTENT)).toBe(true);
      expect(body.subarray(body.length - epilogue.length).equals(epilogue)).toBe(true);
    } finally {
      closeSync(fd);
    }
  });

  it("rebuilds an identical body on a second read of the same fd (retry-safe)", async () => {
    // This is the load-bearing invariant for the idempotentWrite 5xx retry
    // policy on the path branch: each attempt rebuilds the body from the same
    // open fd and must re-send byte-identical content.
    const fd = openSync(filePath, "r");
    try {
      const boundary = makeBoundary();
      const upload = makeUpload(fd);
      const first = await drain(buildMultipartBody(upload, boundary));
      const second = await drain(buildMultipartBody(upload, boundary));
      expect(first.equals(second)).toBe(true);
      expect(first.includes(FILE_CONTENT)).toBe(true);
    } finally {
      closeSync(fd);
    }
  });

  it("does not close the caller's fd (autoClose:false)", async () => {
    const fd = openSync(filePath, "r");
    try {
      const boundary = makeBoundary();
      await drain(buildMultipartBody(makeUpload(fd), boundary));
      // If the stream had closed the fd, this second openSync-independent read
      // via a fresh stream would fail. It must succeed.
      const again = await drain(buildMultipartBody(makeUpload(fd), boundary));
      expect(again.length).toBeGreaterThan(FILE_CONTENT.length);
    } finally {
      closeSync(fd);
    }
  });
});

describe("AF_MCP-3.1 hardening — stream bound to the validated size", () => {
  it("streams exactly the validated byte count even if the file grows in place", async () => {
    const fd = openSync(filePath, "r");
    try {
      const upload = makeUpload(fd); // captures size = current file size
      const validatedSize = upload.file.size;
      // Grow the file in place AFTER the size was validated.
      appendFileSync(filePath, Buffer.alloc(10_000, 0x43));
      const boundary = makeBoundary();
      const body = await drain(buildMultipartBody(upload, boundary));
      const preamble = buildMultipartPreamble(upload, boundary);
      const epilogue = buildMultipartEpilogue(boundary);
      const fileByteCount = body.length - preamble.length - epilogue.length;
      // Bounded read: exactly the validated size, NOT the grown size.
      expect(fileByteCount).toBe(validatedSize);
      expect(fileByteCount).toBeLessThan(validatedSize + 10_000);
    } finally {
      closeSync(fd);
    }
  });

  it("produces a valid multipart with no body bytes for an empty file (size 0)", async () => {
    const emptyPath = join(dir, "empty.bin");
    writeFileSync(emptyPath, Buffer.alloc(0));
    const fd = openSync(emptyPath, "r");
    try {
      const st = fstatSync(fd);
      expect(st.size).toBe(0);
      const upload: MultipartUpload = {
        fields: { filename: "empty.bin" },
        file: {
          fieldName: "file",
          filename: "empty.bin",
          contentType: "application/octet-stream",
          fd,
          sourcePath: emptyPath,
          size: st.size,
          mtimeMs: st.mtimeMs,
        },
      };
      const boundary = makeBoundary();
      const body = await drain(buildMultipartBody(upload, boundary)); // must not throw
      const preamble = buildMultipartPreamble(upload, boundary);
      const epilogue = buildMultipartEpilogue(boundary);
      // No file bytes between preamble and epilogue.
      expect(body.length).toBe(preamble.length + epilogue.length);
      expect(body.subarray(body.length - epilogue.length).equals(epilogue)).toBe(true);
    } finally {
      closeSync(fd);
    }
  });
});

describe("AF_MCP-3.1 hardening — in-read tear detection (generator)", () => {
  function withIntegrity(fd: number): MultipartUpload {
    const u = makeUpload(fd);
    u.integrity = { torn: false };
    return u;
  }

  it("throws MultipartTornReadError before the closing boundary when mutated during the read", async () => {
    const fd = openSync(filePath, "r");
    try {
      const upload = withIntegrity(fd);
      const boundary = makeBoundary();
      const epilogue = buildMultipartEpilogue(boundary);
      const it = buildMultipartBody(upload, boundary)[Symbol.asyncIterator]();
      // First chunk is the preamble; mutate the source in place now so the change
      // overlaps the subsequent file read.
      await it.next();
      appendFileSync(filePath, Buffer.alloc(1000, 0x44));
      let threw = false;
      let sawEpilogue = false;
      try {
        let r = await it.next();
        while (!r.done) {
          if ((r.value as Buffer).includes(epilogue)) sawEpilogue = true;
          r = await it.next();
        }
      } catch (err) {
        threw = true;
        expect(err).toBeInstanceOf(MultipartTornReadError);
      }
      expect(threw).toBe(true);
      expect(upload.integrity!.torn).toBe(true);
      // Discriminate the in-place-mutation branch from the fstat-failed branch.
      expect(upload.integrity!.reason).toContain("modified in place during the read");
      expect(sawEpilogue).toBe(false); // request body is incomplete → server commits nothing
    } finally {
      closeSync(fd);
    }
  });

  it("does NOT throw and emits the closing boundary when the file is mutated AFTER the read", async () => {
    const fd = openSync(filePath, "r");
    try {
      const upload = withIntegrity(fd);
      const boundary = makeBoundary();
      const epilogue = buildMultipartEpilogue(boundary);
      const body = await drain(buildMultipartBody(upload, boundary)); // full read first
      appendFileSync(filePath, Buffer.alloc(1000, 0x45)); // mutate after read completes
      expect(upload.integrity!.torn).toBe(false);
      expect(body.subarray(body.length - epilogue.length).equals(epilogue)).toBe(true);
    } finally {
      closeSync(fd);
    }
  });

  it("skips the integrity check when no integrity object is attached (backward compatible)", async () => {
    const fd = openSync(filePath, "r");
    try {
      const upload = makeUpload(fd); // no integrity object
      const boundary = makeBoundary();
      const it = buildMultipartBody(upload, boundary)[Symbol.asyncIterator]();
      await it.next(); // preamble
      appendFileSync(filePath, Buffer.alloc(1000, 0x46)); // mutate mid-read
      // Without an integrity object the generator does not fstat/throw.
      let threw = false;
      try {
        let r = await it.next();
        while (!r.done) r = await it.next();
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
    } finally {
      closeSync(fd);
    }
  });
});
