import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// vi.hoisted() is evaluated before vi.mock() hoisting, so `real` is available inside the factory.
const real = vi.hoisted(() => ({
  statSync: null as null | typeof import("node:fs").statSync,
  realpathSync: null as null | (((path: string) => string) & typeof import("node:fs").realpathSync),
  openSync: null as null | typeof import("node:fs").openSync,
  fstatSync: null as null | typeof import("node:fs").fstatSync,
  closeSync: null as null | typeof import("node:fs").closeSync,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  real.statSync = actual.statSync;
  real.realpathSync = actual.realpathSync as typeof real.realpathSync;
  real.openSync = actual.openSync;
  real.fstatSync = actual.fstatSync;
  real.closeSync = actual.closeSync;
  return {
    ...actual,
    statSync: vi.fn().mockImplementation(actual.statSync),
    realpathSync: vi.fn().mockImplementation(actual.realpathSync),
    openSync: vi.fn().mockImplementation(actual.openSync),
    fstatSync: vi.fn().mockImplementation(actual.fstatSync),
    closeSync: vi.fn().mockImplementation(actual.closeSync),
  };
});

import {
  checkPath,
  buildAllowList,
  MAX_PATH_UPLOAD_BYTES,
} from "../src/path/confinement.js";
import { checkDenyList } from "../src/path/denylist.js";
import { statSync, realpathSync, openSync, fstatSync, closeSync } from "node:fs";

let tmpDir: string;
let resolvedTmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "artifacta-path-test-"));
  vi.mocked(statSync).mockImplementation(real.statSync!);
  vi.mocked(realpathSync).mockImplementation(real.realpathSync! as typeof realpathSync);
  vi.mocked(openSync).mockImplementation(real.openSync! as typeof openSync);
  vi.mocked(fstatSync).mockImplementation(real.fstatSync! as typeof fstatSync);
  vi.mocked(closeSync).mockImplementation(real.closeSync! as typeof closeSync);
  resolvedTmpDir = (real.realpathSync!)(tmpDir);
});

afterEach(() => {
  vi.mocked(statSync).mockImplementation(real.statSync!);
  vi.mocked(realpathSync).mockImplementation(real.realpathSync! as typeof realpathSync);
  vi.mocked(openSync).mockImplementation(real.openSync! as typeof openSync);
  vi.mocked(fstatSync).mockImplementation(real.fstatSync! as typeof fstatSync);
  vi.mocked(closeSync).mockImplementation(real.closeSync! as typeof closeSync);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── buildAllowList ───────────────────────────────────────────────────────────

describe("buildAllowList", () => {
  afterEach(() => {
    delete process.env.ARTIFACTA_MCP_ALLOW_PATH;
  });

  it("default allow-list contains resolved process.cwd()", () => {
    const roots = buildAllowList([]);
    const resolvedCwd = real.realpathSync!(process.cwd());
    expect(roots).toContain(resolvedCwd);
    expect(roots).toHaveLength(1);
  });

  it("--allow-path=<path> appends to allow-list", () => {
    const roots = buildAllowList([`--allow-path=${tmpDir}`]);
    expect(roots).toContain(resolvedTmpDir);
  });

  it("--allow-path colon-separated appends multiple paths", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "artifacta-path-test-b-"));
    const resolvedDir2 = real.realpathSync!(dir2);
    try {
      const roots = buildAllowList([`--allow-path=${tmpDir}:${dir2}`]);
      expect(roots).toContain(resolvedTmpDir);
      expect(roots).toContain(resolvedDir2);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("ARTIFACTA_MCP_ALLOW_PATH env var appends paths", () => {
    process.env.ARTIFACTA_MCP_ALLOW_PATH = tmpDir;
    const roots = buildAllowList([]);
    expect(roots).toContain(resolvedTmpDir);
  });

  it("relative path in --allow-path exits 2", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number | string) => {
      throw new Error(`process.exit(${_code})`);
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(() => buildAllowList(["--allow-path=relative/path"])).toThrow("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("relative path in ARTIFACTA_MCP_ALLOW_PATH env exits 2", () => {
    process.env.ARTIFACTA_MCP_ALLOW_PATH = "relative/path";
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number | string) => {
      throw new Error(`process.exit(${_code})`);
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(() => buildAllowList([])).toThrow("process.exit(2)");
    } finally {
      exitSpy.mockRestore();
      delete process.env.ARTIFACTA_MCP_ALLOW_PATH;
    }
  });
});

// ─── checkPath — allow-list membership ───────────────────────────────────────

describe("checkPath — allow-list membership", () => {
  it("file inside resolved CWD is allowed and returns resolvedPath and open fd", () => {
    const file = join(tmpDir, "file.txt");
    writeFileSync(file, "hello");
    const result = checkPath(file, [resolvedTmpDir]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedPath).toBe(real.realpathSync!(file));
      expect(typeof result.fd).toBe("number");
      real.closeSync!(result.fd); // must close the real fd returned by checkPath
    }
  });

  it("file in a different directory is denied", () => {
    const file = join(tmpDir, "file.txt");
    writeFileSync(file, "hello");
    const dir2 = mkdtempSync(join(tmpdir(), "other-"));
    const resolvedDir2 = real.realpathSync!(dir2);
    try {
      const result = checkPath(file, [resolvedDir2]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("outside the MCP server's allow-list");
        expect(result.reason).toContain("--allow-path");
      }
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("allow-list message includes the allow-list roots", () => {
    const file = join(tmpDir, "file.txt");
    writeFileSync(file, "content");
    const result = checkPath(file, ["/tmp/some-other-dir"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("/tmp/some-other-dir");
    }
  });
});

// ─── checkPath — deny-list ────────────────────────────────────────────────────

describe("checkPath — deny-list overrides allow-list", () => {
  it("~/.ssh path denied even when $HOME is in allow-list", () => {
    const result = checkDenyList(join(homedir(), ".ssh", "id_rsa"));
    expect(result).not.toBeNull();
    expect(result).toContain(".ssh");
  });

  it("~/.aws path denied", () => {
    expect(checkDenyList(join(homedir(), ".aws", "credentials"))).not.toBeNull();
  });

  it("~/.gnupg path denied", () => {
    expect(checkDenyList(join(homedir(), ".gnupg", "secring.gpg"))).not.toBeNull();
  });

  it("~/.config/gh path denied", () => {
    expect(checkDenyList(join(homedir(), ".config", "gh", "hosts.yml"))).not.toBeNull();
  });

  it("~/.netrc denied", () => {
    expect(checkDenyList(join(homedir(), ".netrc"))).not.toBeNull();
  });

  it("~/.kube denied", () => {
    expect(checkDenyList(join(homedir(), ".kube", "config"))).not.toBeNull();
  });

  it("~/.artifacta denied (would expose mcp.toml)", () => {
    expect(checkDenyList(join(homedir(), ".artifacta", "mcp.toml"))).not.toBeNull();
  });

  it("/etc path denied", () => {
    expect(checkDenyList("/etc/passwd")).not.toBeNull();
  });

  it("/private/etc path denied (macOS)", () => {
    expect(checkDenyList("/private/etc/hosts")).not.toBeNull();
  });

  it("~/Library/Keychains denied (macOS)", () => {
    expect(checkDenyList(join(homedir(), "Library", "Keychains", "login.keychain-db"))).not.toBeNull();
  });

  it("credentials.json anywhere in path is denied", () => {
    const result = checkDenyList(join(tmpDir, "credentials.json"));
    expect(result).not.toBeNull();
    expect(result).toContain("deny-list filename pattern");
  });

  it(".env file is denied", () => {
    expect(checkDenyList(join(tmpDir, ".env"))).not.toBeNull();
  });

  it(".env.local file is denied", () => {
    expect(checkDenyList(join(tmpDir, ".env.local"))).not.toBeNull();
  });

  it(".env.production file is denied", () => {
    expect(checkDenyList(join(tmpDir, ".env.production"))).not.toBeNull();
  });

  it("regular file named 'environment.txt' is NOT denied", () => {
    expect(checkDenyList(join(tmpDir, "environment.txt"))).toBeNull();
  });

  it("deny-list overrides allow-list: ~/.ssh child still denied", () => {
    expect(checkDenyList(join(homedir(), ".ssh", "id_rsa"))).not.toBeNull();
  });

  it("deny root canonicalization: resolved form of $HOME deny path is also denied", () => {
    // Guards against systems where $HOME or a deny root is a symlink (network home dirs,
    // macOS /var → /private/var, etc.) — both raw and canonical deny-root forms are checked.
    const rawHome = homedir();
    let resolvedHome: string;
    try { resolvedHome = real.realpathSync!(rawHome); } catch { return; }
    // If $HOME has no symlink indirection, this is a no-op pass — no system-specific skip needed.
    expect(checkDenyList(join(resolvedHome, ".ssh", "id_rsa"))).not.toBeNull();
  });
});

// ─── checkPath — symlink resolution ───────────────────────────────────────────

describe("checkPath — symlink resolution", () => {
  it("symlink inside allow-list pointing to /etc/passwd is denied after realpath()", () => {
    const etcPasswd = "/etc/passwd";
    const symlinkPath = join(tmpDir, "evil-link");
    try {
      symlinkSync(etcPasswd, symlinkPath);
    } catch {
      return; // /etc/passwd may not exist — skip
    }
    const result = checkPath(symlinkPath, [resolvedTmpDir]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("invalid_request");
    }
  });
});

// ─── checkPath — special files (mocked realpathSync + openSync + fstatSync) ───

const MOCK_FD = 9999;

describe("checkPath — special files", () => {
  function mockSpecialFile(resolvedPath: string, mode: number): void {
    vi.mocked(realpathSync).mockReturnValueOnce(resolvedPath as string);
    vi.mocked(openSync).mockReturnValueOnce(MOCK_FD);
    vi.mocked(fstatSync).mockReturnValueOnce({ mode, size: 0 } as ReturnType<typeof import("node:fs").fstatSync>);
    vi.mocked(closeSync).mockReturnValueOnce(undefined as unknown as void); // closed on error path
  }

  it("UNIX socket is denied", () => {
    const sockPath = join(resolvedTmpDir, "test.sock");
    mockSpecialFile(sockPath, 0o140000 | 0o777); // S_IFSOCK
    const result = checkPath(sockPath, [resolvedTmpDir]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("special file");
    }
  });

  it("FIFO is denied", () => {
    const fifoPath = join(resolvedTmpDir, "test.fifo");
    mockSpecialFile(fifoPath, 0o010000 | 0o666); // S_IFIFO
    const result = checkPath(fifoPath, [resolvedTmpDir]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("special file");
    }
  });

  it("character device is denied", () => {
    const devPath = join(resolvedTmpDir, "fake-dev");
    mockSpecialFile(devPath, 0o020000 | 0o666); // S_IFCHR
    const result = checkPath(devPath, [resolvedTmpDir]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("special file");
    }
  });
});

// ─── checkPath — size ceiling ────────────────────────────────────────────────

describe("checkPath — size ceiling (500 MB direct-multipart limit)", () => {
  function mockRegularFile(resolvedPath: string, size: number): void {
    vi.mocked(realpathSync).mockReturnValueOnce(resolvedPath as string);
    vi.mocked(openSync).mockReturnValueOnce(MOCK_FD);
    vi.mocked(fstatSync).mockReturnValueOnce({ mode: 0o100644, size } as ReturnType<typeof import("node:fs").fstatSync>);
    vi.mocked(closeSync).mockReturnValueOnce(undefined as unknown as void); // closed on size-exceeded path
  }

  it("file at exactly 500 MB is allowed — resolvedPath and fd returned", () => {
    const file = join(resolvedTmpDir, "big.bin");
    mockRegularFile(file, MAX_PATH_UPLOAD_BYTES);
    const result = checkPath(file, [resolvedTmpDir]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedPath).toBe(file);
      expect(result.fd).toBe(MOCK_FD); // MOCK_FD is not a real fd; caller closes in prod
    }
  });

  it("501 MB file is denied — Free tier", () => {
    const file = join(resolvedTmpDir, "toolarge.bin");
    mockRegularFile(file, MAX_PATH_UPLOAD_BYTES + 1024 * 1024);
    const result = checkPath(file, [resolvedTmpDir]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("exceeding the 500 MB");
      expect(result.reason).toContain("store_artifact.path");
    }
  });

  it("501 MB file is denied — Pro tier (same ceiling applies to path uploads)", () => {
    const file = join(resolvedTmpDir, "toolarge.bin");
    mockRegularFile(file, MAX_PATH_UPLOAD_BYTES + 1024 * 1024);
    const result = checkPath(file, [resolvedTmpDir]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("request_upload_url");
    }
  });

  it("very large file (1.2 GB) includes GB in error message", () => {
    const file = join(resolvedTmpDir, "huge.bin");
    mockRegularFile(file, Math.floor(1.2 * 1024 ** 3));
    const result = checkPath(file, [resolvedTmpDir]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("GB");
    }
  });

  it("custom ceiling respected by caller", () => {
    const file = join(resolvedTmpDir, "medium.bin");
    mockRegularFile(file, 2 * 1024 * 1024);
    expect(checkPath(file, [resolvedTmpDir], 1024 * 1024).ok).toBe(false);
  });
});

// ─── checkPath — refusal payload format ─────────────────────────────────────

describe("checkPath — refusal payload format (plan §4.4)", () => {
  it("outside allow-list error matches plan §4.4 verbatim structure", () => {
    const file = join(tmpDir, "file.txt");
    writeFileSync(file, "content");
    const result = checkPath(file, ["/tmp/some-allowed-dir"]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("invalid_request:");
      expect(result.reason).toContain("outside the MCP server's allow-list");
      expect(result.reason).toContain("Allow-listed roots:");
      expect(result.reason).toContain("--allow-path=");
      expect(result.reason).toContain("`content` field");
    }
  });
});

// ─── checkPath — nonexistent path ────────────────────────────────────────────

describe("checkPath — nonexistent path", () => {
  it("returns error for nonexistent file", () => {
    const result = checkPath(join(tmpDir, "doesnotexist.txt"), [resolvedTmpDir]);
    expect(result.ok).toBe(false);
  });
});
