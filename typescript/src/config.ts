import { readFileSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

export const DEFAULT_API_URL = "https://api.artifacta.io";
/** API-key shape: `ak_live_` + 32 alphanumerics. Shared by stdio config loading
 * and the hosted HTTP bearer resolver (src/http/auth.ts). */
export const KEY_REGEX = /^ak_live_[a-zA-Z0-9]{32}$/;

// Computed lazily. _ARTIFACTA_TOML_PATH_OVERRIDE is a test-only escape hatch
// (same pattern as _ARTIFACTA_TEST_INJECT_EXCEPTION in cli.ts).
function tomlPath(): string {
  return (
    process.env._ARTIFACTA_TOML_PATH_OVERRIDE ??
    join(homedir(), ".artifacta", "mcp.toml")
  );
}

export interface Config {
  apiKey: string | undefined;
  apiUrl: string;
}

interface TomlSection {
  api_key?: unknown;
  api_url?: unknown;
}

type TomlFile = Record<string, TomlSection>;

function validateKeyShape(key: string, source: string): void {
  if (!KEY_REGEX.test(key)) {
    process.stderr.write(
      `[artifacta-mcp] invalid API key from ${source}: key must match ak_live_ + 32 alphanumeric characters\n`
    );
    process.exit(2);
  }
}

function checkTomlPermissions(): void {
  if (platform() === "win32") {
    process.stderr.write(
      "[artifacta-mcp] warning: Windows file permission enforcement is not available in this version; ensure ~/.artifacta/mcp.toml is readable only by your user.\n"
    );
    return;
  }
  let mode: number;
  try {
    mode = statSync(tomlPath()).mode;
  } catch {
    return; // file doesn't exist — handled elsewhere
  }
  const worldWrite = mode & 0o002;
  const worldRead = mode & 0o004;
  if (worldWrite) {
    process.stderr.write(
      "[artifacta-mcp] refusing to start: ~/.artifacta/mcp.toml is world-writable. Run: chmod 600 ~/.artifacta/mcp.toml\n"
    );
    process.exit(2);
  }
  if (worldRead) {
    process.stderr.write(
      "[artifacta-mcp] warning: ~/.artifacta/mcp.toml is world-readable; consider running: chmod 600 ~/.artifacta/mcp.toml\n"
    );
  }
}

function loadTomlSection(profile: string): TomlSection | null {
  let raw: string;
  try {
    raw = readFileSync(tomlPath(), "utf-8");
  } catch {
    return null;
  }
  checkTomlPermissions();
  let parsed: TomlFile;
  try {
    parsed = parseToml(raw) as TomlFile;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[artifacta-mcp] failed to parse ~/.artifacta/mcp.toml: ${msg}\n`);
    process.exit(2);
  }
  const section = parsed[profile];
  if (!section) {
    const available = Object.keys(parsed).join(", ") || "(none)";
    process.stderr.write(
      `[artifacta-mcp] profile "${profile}" not found in ~/.artifacta/mcp.toml. Available: ${available}\n`
    );
    process.exit(2);
  }
  return section;
}

export function loadConfig(argv: string[]): Config {
  // Parse flags — support both --flag=value and --flag value forms
  function flag(name: string): string | undefined {
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === `--${name}` && i + 1 < argv.length) return argv[i + 1];
      const prefix = `--${name}=`;
      if (argv[i].startsWith(prefix)) return argv[i].slice(prefix.length);
    }
    return undefined;
  }

  const flagKey = flag("api-key");
  const flagUrl = flag("api-url");
  const flagProfile = flag("profile");

  const profile =
    flagProfile ?? process.env.ARTIFACTA_PROFILE ?? "default";

  // Resolve api_url from TOML section when no explicit --api-url flag
  let tomlSection: TomlSection | null = null;

  // 1. --api-key flag (highest precedence)
  if (flagKey !== undefined) {
    validateKeyShape(flagKey, "--api-key flag");
    // Still load TOML section for api_url if --profile was passed and no --api-url
    if (flagProfile !== undefined && flagUrl === undefined) {
      tomlSection = loadTomlSection(profile);
    }
    const apiUrl =
      flagUrl ??
      (tomlSection && typeof tomlSection.api_url === "string"
        ? tomlSection.api_url
        : undefined) ??
      process.env.ARTIFACTA_API_URL ??
      DEFAULT_API_URL;
    return { apiKey: flagKey, apiUrl };
  }

  // 2. ARTIFACTA_API_KEY env var
  const envKey = process.env.ARTIFACTA_API_KEY;
  if (envKey !== undefined && envKey !== "") {
    validateKeyShape(envKey, "ARTIFACTA_API_KEY env var");
    const apiUrl =
      flagUrl ?? process.env.ARTIFACTA_API_URL ?? DEFAULT_API_URL;
    return { apiKey: envKey, apiUrl };
  }

  // 3. ~/.artifacta/mcp.toml
  tomlSection = loadTomlSection(profile);
  if (tomlSection !== null) {
    const tomlKey = tomlSection.api_key;
    if (tomlKey !== undefined) {
      if (typeof tomlKey !== "string") {
        process.stderr.write(
          `[artifacta-mcp] api_key in ~/.artifacta/mcp.toml [${profile}] must be a string\n`
        );
        process.exit(2);
      }
      validateKeyShape(tomlKey, `~/.artifacta/mcp.toml [${profile}]`);
    }
    const tomlUrl =
      typeof tomlSection.api_url === "string" ? tomlSection.api_url : undefined;
    const apiUrl =
      flagUrl ?? tomlUrl ?? process.env.ARTIFACTA_API_URL ?? DEFAULT_API_URL;
    return {
      apiKey: typeof tomlKey === "string" ? tomlKey : undefined,
      apiUrl,
    };
  }

  // 4. No key found — server starts cleanly; first tool call will surface error
  const apiUrl =
    flagUrl ?? process.env.ARTIFACTA_API_URL ?? DEFAULT_API_URL;
  return { apiKey: undefined, apiUrl };
}
