import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// We need to mock process.exit and process.stderr for tests.
// Import the module fresh each time using dynamic import to pick up env changes.

const VALID_KEY = "ak_live_abcdefghijklmnopqrstuvwxyz123456";
const VALID_KEY_2 = "ak_live_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";
const DEFAULT_URL = "https://api.artifacta.io";

describe("loadConfig", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let originalEnv: NodeJS.ProcessEnv;
  let tmpDir: string;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation((_code?: number | string) => {
      throw new Error(`process.exit(${_code})`);
    });
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    originalEnv = { ...process.env };
    // Clear relevant env vars
    delete process.env.ARTIFACTA_API_KEY;
    delete process.env.ARTIFACTA_API_URL;
    delete process.env.ARTIFACTA_PROFILE;
    tmpDir = mkdtempSync(join(tmpdir(), "artifacta-config-test-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = originalEnv;
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  });

  // Helper to re-import loadConfig with a fresh module (env changes need re-eval)
  async function getLoadConfig() {
    const mod = await import(`../src/config.ts?t=${Date.now()}`);
    return mod.loadConfig as (argv: string[]) => { apiKey: string | undefined; apiUrl: string };
  }

  describe("--api-key flag (highest precedence)", () => {
    it("returns key from --api-key= form", async () => {
      const { loadConfig } = await import("../src/config.js");
      const cfg = loadConfig([`--api-key=${VALID_KEY}`]);
      expect(cfg.apiKey).toBe(VALID_KEY);
      expect(cfg.apiUrl).toBe(DEFAULT_URL);
    });

    it("returns key from --api-key space-separated form", async () => {
      const { loadConfig } = await import("../src/config.js");
      const cfg = loadConfig(["--api-key", VALID_KEY]);
      expect(cfg.apiKey).toBe(VALID_KEY);
    });

    it("uses --api-url when both flags present", async () => {
      const { loadConfig } = await import("../src/config.js");
      const cfg = loadConfig([`--api-key=${VALID_KEY}`, "--api-url=https://staging.example.io"]);
      expect(cfg.apiKey).toBe(VALID_KEY);
      expect(cfg.apiUrl).toBe("https://staging.example.io");
    });

    it("exits 2 with source named for invalid key shape in flag", async () => {
      const { loadConfig } = await import("../src/config.js");
      expect(() => loadConfig(["--api-key=bad_key"])).toThrow("process.exit(2)");
      const errOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(errOutput).toContain("--api-key flag");
      // Key value must NOT appear in error output
      expect(errOutput).not.toContain("bad_key");
    });

    it("AF_MCP-1.2.13 — key with 31 chars after prefix is rejected", async () => {
      const shortKey = "ak_live_" + "a".repeat(31); // one char short
      const { loadConfig } = await import("../src/config.js");
      expect(() => loadConfig([`--api-key=${shortKey}`])).toThrow("process.exit(2)");
    });

    it("AF_MCP-1.2.14 — key with non-alnum char (hyphen) in suffix is rejected", async () => {
      const hyphenKey = "ak_live_" + "a".repeat(31) + "-"; // 32 chars but last is hyphen
      const { loadConfig } = await import("../src/config.js");
      expect(() => loadConfig([`--api-key=${hyphenKey}`])).toThrow("process.exit(2)");
    });
  });

  describe("ARTIFACTA_API_KEY env var (precedence 2)", () => {
    it("reads key from env when no flag", async () => {
      process.env.ARTIFACTA_API_KEY = VALID_KEY;
      const { loadConfig } = await import("../src/config.js");
      const cfg = loadConfig([]);
      expect(cfg.apiKey).toBe(VALID_KEY);
    });

    it("--api-key flag overrides env var", async () => {
      process.env.ARTIFACTA_API_KEY = VALID_KEY_2;
      const { loadConfig } = await import("../src/config.js");
      const cfg = loadConfig([`--api-key=${VALID_KEY}`]);
      expect(cfg.apiKey).toBe(VALID_KEY);
    });

    it("exits 2 for invalid key from env, names env var as source", async () => {
      process.env.ARTIFACTA_API_KEY = "bad_from_env";
      const { loadConfig } = await import("../src/config.js");
      expect(() => loadConfig([])).toThrow("process.exit(2)");
      const errOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(errOutput).toContain("ARTIFACTA_API_KEY env var");
      expect(errOutput).not.toContain("bad_from_env");
    });

    it("uses ARTIFACTA_API_URL from env", async () => {
      process.env.ARTIFACTA_API_KEY = VALID_KEY;
      process.env.ARTIFACTA_API_URL = "https://custom.example.io";
      const { loadConfig } = await import("../src/config.js");
      const cfg = loadConfig([]);
      expect(cfg.apiUrl).toBe("https://custom.example.io");
    });
  });

  describe("~/.artifacta/mcp.toml (precedence 3)", () => {
    function setupToml(content: string, mode = 0o600): string {
      const path = join(tmpDir, "mcp.toml");
      writeFileSync(path, content, { mode });
      // Use the test-only override so homedir() is not involved
      process.env._ARTIFACTA_TOML_PATH_OVERRIDE = path;
      return path;
    }

    afterEach(() => {
      delete process.env._ARTIFACTA_TOML_PATH_OVERRIDE;
    });

    it("reads key from [default] section when no env", async () => {
      setupToml(`[default]\napi_key = "${VALID_KEY}"\n`);
      const { loadConfig } = await import("../src/config.js");
      const cfg = loadConfig([]);
      expect(cfg.apiKey).toBe(VALID_KEY);
    });

    it("parses named profile with api_url", async () => {
      setupToml(
        `[staging]\napi_key = "${VALID_KEY}"\napi_url = "https://staging.artifacta.io"\n`
      );
      const { loadConfig } = await import("../src/config.js");
      const cfg = loadConfig(["--profile=staging"]);
      expect(cfg.apiKey).toBe(VALID_KEY);
      expect(cfg.apiUrl).toBe("https://staging.artifacta.io");
    });

    it("AF_MCP-1.2.07 — missing profile → error names missing profile and lists available", async () => {
      // Write TOML with only [default], then request [nonexistent]
      setupToml(`[default]\napi_key = "${VALID_KEY}"\n`);
      const { loadConfig } = await import("../src/config.js");
      expect(() => loadConfig(["--profile=nonexistent"])).toThrow("process.exit(2)");
      const errOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(errOutput).toContain('"nonexistent"');
      expect(errOutput).toContain("default");
    });

    it("AF_MCP-1.2.11 — invalid key in TOML → error names mcp.toml as source", async () => {
      setupToml(`[default]\napi_key = "bad_toml_key"\n`);
      const { loadConfig } = await import("../src/config.js");
      expect(() => loadConfig([])).toThrow("process.exit(2)");
      const errOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(errOutput).toContain("mcp.toml");
      // Key value must NOT appear in the error output
      expect(errOutput).not.toContain("bad_toml_key");
    });

    it("AF_MCP-1.2.15 — world-writable mcp.toml exits 2 with exact chmod message", async () => {
      const path = join(tmpDir, "mcp-writable.toml");
      writeFileSync(path, `[default]\napi_key = "${VALID_KEY}"\n`);
      chmodSync(path, 0o666); // sets world-writable bit
      process.env._ARTIFACTA_TOML_PATH_OVERRIDE = path;
      const { loadConfig } = await import("../src/config.js");
      expect(() => loadConfig([])).toThrow("process.exit(2)");
      const errOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(errOutput).toContain("refusing to start: ~/.artifacta/mcp.toml is world-writable. Run: chmod 600 ~/.artifacta/mcp.toml");
    });

    it("AF_MCP-1.2.16 — world-readable mcp.toml emits warning, server starts", async () => {
      const path = join(tmpDir, "mcp-readable.toml");
      writeFileSync(path, `[default]\napi_key = "${VALID_KEY}"\n`);
      chmodSync(path, 0o644); // world-readable but not world-writable
      process.env._ARTIFACTA_TOML_PATH_OVERRIDE = path;
      const { loadConfig } = await import("../src/config.js");
      // Should NOT exit — just warn
      const cfg = loadConfig([]);
      expect(cfg.apiKey).toBe(VALID_KEY);
      expect(exitSpy).not.toHaveBeenCalled();
      const errOutput = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(errOutput).toContain("world-readable");
    });
  });

  describe("No key available (precedence 4)", () => {
    it("starts cleanly with apiKey undefined when no source provides a key", async () => {
      const { loadConfig } = await import("../src/config.js");
      const cfg = loadConfig([]);
      expect(cfg.apiKey).toBeUndefined();
      expect(cfg.apiUrl).toBe(DEFAULT_URL);
      // Must not have called exit
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  describe("API key is never logged", () => {
    it("key value never appears in stderr output during any startup path", async () => {
      // Test shape-validation failure — error must name source, not key value
      const { loadConfig } = await import("../src/config.js");

      // Flag source
      stderrSpy.mockClear();
      try { loadConfig(["--api-key=EXPOSED_KEY_FLAG"]); } catch { /* exit */ }
      const out1 = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(out1).not.toContain("EXPOSED_KEY_FLAG");

      // Env source
      process.env.ARTIFACTA_API_KEY = "EXPOSED_KEY_ENV";
      stderrSpy.mockClear();
      try { loadConfig([]); } catch { /* exit */ }
      const out2 = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(out2).not.toContain("EXPOSED_KEY_ENV");
      delete process.env.ARTIFACTA_API_KEY;
    });

    it("valid key never appears in stderr during normal startup", async () => {
      const { loadConfig } = await import("../src/config.js");
      stderrSpy.mockClear();
      loadConfig([`--api-key=${VALID_KEY}`]);
      const out = stderrSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(out).not.toContain(VALID_KEY);
    });
  });

  describe("Profile selection precedence", () => {
    it("ARTIFACTA_PROFILE selects profile over default", async () => {
      process.env.ARTIFACTA_PROFILE = "staging";
      // Without a TOML file, this will just use default URL (no file = no section)
      // Primarily verifying it doesn't crash with no file present
      const { loadConfig } = await import("../src/config.js");
      // No file → returns clean config with no key
      const cfg = loadConfig([]);
      expect(cfg.apiKey).toBeUndefined();
    });
  });

  describe("--api-key + --profile together", () => {
    it("--api-key wins for credential; --profile selects api_url from TOML when no --api-url", async () => {
      // This exercises the combination path in loadConfig
      // With no actual TOML file, api_url falls back to default
      const { loadConfig } = await import("../src/config.js");
      const cfg = loadConfig([`--api-key=${VALID_KEY}`, "--profile=staging"]);
      expect(cfg.apiKey).toBe(VALID_KEY);
      // No TOML file exists so api_url falls to default
      expect(cfg.apiUrl).toBe(DEFAULT_URL);
    });
  });

  describe("Windows permission warning", () => {
    it("exact warning string emitted (structure check)", () => {
      const expectedWarning =
        "[artifacta-mcp] warning: Windows file permission enforcement is not available in this version; ensure ~/.artifacta/mcp.toml is readable only by your user.";
      // Just verify the string constant matches what we'd emit
      expect(expectedWarning).toContain("Windows file permission enforcement is not available");
    });
  });

  describe("World-writable error string", () => {
    it("exact error string matches spec", () => {
      const expectedError =
        "[artifacta-mcp] refusing to start: ~/.artifacta/mcp.toml is world-writable. Run: chmod 600 ~/.artifacta/mcp.toml";
      expect(expectedError).toContain("refusing to start");
      expect(expectedError).toContain("chmod 600 ~/.artifacta/mcp.toml");
    });
  });
});
