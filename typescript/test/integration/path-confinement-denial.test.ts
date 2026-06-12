// AF_MCP-7.2.12–18 — Path-confinement denial subsuite (Phase 2 hard gate).
//
// Per plan §4.4 / §9.2 and the QA spec: the denial cases must fire when a tool
// receives a `path` argument the engine refuses.
//
// Cases 7.2.12–18 exercise the `checkPath()` engine directly: it is the
// authoritative §4.4 text contract, and the size-cap cases (7.2.16/17) can only
// be driven with a small ceiling (a real 501 MB file is impractical in CI),
// which the tool surface — hard-wired to the 500 MB ceiling — cannot inject.
//
// AF_MCP-3.1 (Phase 6a) shipped `store_artifact`, the first `path`-taking tool.
// Case 7.2.12e below adds the end-to-end proof that a denied path dispatched
// through the real `store_artifact` handler returns the same `invalid_request`
// refusal and never reaches the HTTP layer (the handler→engine wiring is also
// unit-proven in `tool-store-artifact.test.ts` AF_MCP-3.1.06).
//
// HOME spoofing: `path/denylist.ts` builds DENY_ROOTS from `homedir()` at
// module-evaluation time. We need a writable HOME so we can materialize the
// `~/.ssh/id_rsa` fixture without touching the developer's real key. `vi.hoisted`
// runs BEFORE static imports so we can rewrite `process.env.HOME` first; the
// denylist module then resolves DENY_ROOTS against the temp HOME.
//
// Pre-creating the deny-list subdirs (`/.ssh`, `/.aws`, ...) inside the temp
// HOME lets `resolveDenyRoot()` realpath them — important on macOS, where
// `/var/folders` is a symlink to `/private/var/folders`. Without that the
// resolved input path (`/private/var/...`) would not match the unresolved
// deny root captured at module load.

import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

const fixture = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("node:path") as typeof import("node:path");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "afmcp-int-home-"));
  process.env.HOME = home;
  // USERPROFILE keeps Node's homedir() honest on Windows runners.
  process.env.USERPROFILE = home;
  for (const sub of [".ssh", ".aws", ".gnupg", ".kube", ".artifacta", "Library/Keychains"]) {
    fs.mkdirSync(path.join(home, sub), { recursive: true });
  }
  return { fakeHome: home };
});

import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { createServer, type Server as NetServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkPath, buildAllowList } from "../../src/path/confinement.js";
import { setAllowRoots, resetAllowRoots } from "../../src/path/allowlist.js";
import { resetHttpClient } from "../../src/http/instance.js";
import {
  clearRegistry,
  getToolRegistration,
} from "../../src/safety/registry.js";
import { registerStoreArtifactTool } from "../../src/tools/store-artifact.js";

const { fakeHome } = fixture;
const fakeHomeReal = realpathSync(fakeHome);

let workdir: string;
let workdirReal: string;

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), "afmcp-int-work-"));
  workdirReal = realpathSync(workdir);
});

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

// All denial cases assert the engine response shape contracted by §4.4:
//   { ok: false, reason: "invalid_request: ..." }
// translateHttpFailure isn't involved (path checks fire client-side before any
// HTTP call), so the contract is the literal `reason` text.

describe("AF_MCP-7.2.12 — `~/.ssh/id_rsa` denied (deny-list rule named)", () => {
  it("returns invalid_request and names the .ssh deny-list rule", () => {
    const file = join(fakeHome, ".ssh", "id_rsa");
    writeFileSync(file, "fake-key-bytes\n");
    const allowRoots = [fakeHomeReal];
    const result = checkPath(file, allowRoots);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^invalid_request:/);
    expect(result.reason).toContain(".ssh");
    expect(result.reason).toContain("deny-list");
  });
});

describe("AF_MCP-7.2.13 — parent-traversal path denied (after realpath normalization)", () => {
  it("`<workdir>/../../../etc/passwd` collapses to /etc/passwd and is denied", () => {
    // Many `..` segments climb past root; POSIX absorbs the extras and
    // `realpathSync` collapses the input to `/etc/passwd`.
    const upDirs = Array(16).fill("..").join("/");
    const traversal = join(workdir, upDirs, "etc", "passwd");
    const allowRoots = [workdirReal];
    const result = checkPath(traversal, allowRoots);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^invalid_request:/);
    expect(result.reason).toContain("deny-list");
    // Resolved form must mention /etc (the deny root that fired).
    expect(result.reason).toMatch(/\/etc\b/);
  });
});

describe("AF_MCP-7.2.14 — symlink in CWD pointing to /etc/passwd denied", () => {
  it("realpath resolves the symlink target; deny-list catches /etc", () => {
    const link = join(workdir, "passwd-link");
    try {
      symlinkSync("/etc/passwd", link);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const allowRoots = [workdirReal];
    const result = checkPath(link, allowRoots);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^invalid_request:/);
    expect(result.reason).toContain("deny-list");
  });
});

describe("AF_MCP-7.2.15 — UNIX socket denied (special-file rejection)", () => {
  it("rejects with formatSpecialFile()", async () => {
    const sockPath = join(workdir, "test.sock");
    const sock: NetServer = createServer();
    await new Promise<void>((resolve, reject) => {
      sock.once("error", reject);
      sock.listen(sockPath, () => {
        sock.removeListener("error", reject);
        resolve();
      });
    });
    try {
      const allowRoots = [workdirReal];
      const result = checkPath(sockPath, allowRoots);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toMatch(/^invalid_request:/);
      // formatSpecialFile() text:
      //   "is a special file (socket, device, FIFO, or symlink to special)"
      expect(result.reason).toMatch(/special file|socket|FIFO|device/i);
    } finally {
      await new Promise<void>((resolve) => sock.close(() => resolve()));
      try { rmSync(sockPath, { force: true }); } catch { /* socket node may be gone */ }
    }
  });
});

describe("AF_MCP-7.2.16 — 501 MB file denied on Free tenant (size cap)", () => {
  it("returns invalid_request naming the 500 MB ceiling", () => {
    // We don't materialize a 501 MB file in CI — instead drive the engine with
    // a small ceiling so a tiny test file is over-cap. The hard-coded
    // "500 MB direct-upload ceiling" string in `formatSizeExceeded()` is the
    // contracted text the QA spec asserts.
    const file = join(workdir, "size-test-free.bin");
    writeFileSync(file, Buffer.alloc(2048));
    const allowRoots = [workdirReal];
    const result = checkPath(file, allowRoots, /* ceilingBytes */ 1024);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^invalid_request:/);
    expect(result.reason).toContain("500 MB direct-upload ceiling");
  });
});

describe("AF_MCP-7.2.17 — 501 MB file denied on Pro tenant (alternative named)", () => {
  it("size cap is transport-bound, not plan-bound; message names request_upload_url", () => {
    // Per AF_MCP-1.6: ceiling is the same on Free and Pro because store_artifact.path
    // has no presigned fallback. The Pro-flavor refusal must surface the
    // alternative — `request_upload_url` — so the agent knows the next move.
    const file = join(workdir, "size-test-pro.bin");
    writeFileSync(file, Buffer.alloc(2048));
    const allowRoots = [workdirReal];
    const result = checkPath(file, allowRoots, /* ceilingBytes */ 1024);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^invalid_request:/);
    expect(result.reason).toContain("500 MB direct-upload ceiling");
    expect(result.reason).toContain("request_upload_url");
  });
});

describe("AF_MCP-7.2.18 — `--allow-path=$HOME` still denies `~/.ssh` (deny-list overrides)", () => {
  it("the suite's tripwire: deny-list always wins over allow-list", () => {
    const file = join(fakeHome, ".ssh", "id_rsa-tripwire");
    writeFileSync(file, "fake-key-bytes\n");
    // Caller widens allow-list to cover $HOME.
    const allowRoots = buildAllowList(["--allow-path=" + fakeHome]);
    expect(allowRoots).toContain(fakeHomeReal);
    const result = checkPath(file, allowRoots);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/^invalid_request:/);
    expect(result.reason).toContain("deny-list");
    expect(result.reason).toContain(".ssh");
  });
});

describe("AF_MCP-7.2.12e — denied path dispatched through `store_artifact` (end-to-end)", () => {
  // Proves the Phase-6a tool routes path inputs through the confinement engine
  // BEFORE any HTTP call: no client is wired, so reaching the HTTP layer would
  // throw "HTTP client not initialised" — the test passes only because the
  // refusal returns first.
  it("returns the §4.4 refusal and never reaches the HTTP layer", async () => {
    const file = join(fakeHome, ".ssh", "id_rsa-e2e");
    writeFileSync(file, "fake-key-bytes\n");
    resetHttpClient();
    clearRegistry();
    registerStoreArtifactTool();
    // Allow-list covers $HOME; deny-list must still override for ~/.ssh.
    setAllowRoots(buildAllowList(["--allow-path=" + fakeHome]));
    try {
      const reg = getToolRegistration("store_artifact");
      const result = await reg!.handler(
        { filename: "id_rsa", path: file, content_type: "text/plain" },
        { requestId: "integration-7.2.12e" }
      );
      expect(result.isError).toBe(true);
      const meta = result._meta as { code?: string } | undefined;
      expect(meta?.code).toBe("invalid_request");
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toMatch(/^invalid_request:/);
      expect(text).toContain("deny-list");
      expect(text).toContain(".ssh");
    } finally {
      resetAllowRoots();
      clearRegistry();
    }
  });
});
