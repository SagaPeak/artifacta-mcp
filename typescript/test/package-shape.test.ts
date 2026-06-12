import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(__filename)); // the typescript/ package root

// The CI/publish workflows live at the monorepo root (where this package sits
// at mcp/typescript/). The standalone public mirror (SagaPeak/artifacta-mcp)
// carries no workflows, so locate them by walking up instead of assuming a
// fixed depth, and skip the workflow tests when they are absent.
function findWorkflowsDir(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, ".github", "workflows");
    if (existsSync(join(candidate, "mcp-typescript.yml"))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
const WORKFLOWS_DIR = findWorkflowsDir(ROOT);

interface PackageJson {
  name?: string;
  version?: string;
  mcpName?: string;
  description?: string;
  type?: string;
  main?: string;
  bin?: Record<string, string>;
  files?: string[];
  engines?: Record<string, string>;
  scripts?: Record<string, string>;
  publishConfig?: Record<string, string>;
  license?: string;
  author?: string;
  repository?: { type?: string; url?: string; directory?: string };
  homepage?: string;
  keywords?: string[];
  dependencies?: Record<string, string>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

describe("AF_MCP-6.1 — npm package shape", () => {
  const pkg = readJson<PackageJson>(join(ROOT, "package.json"));

  it("name is @artifacta-mcp/mcp (OQ#2 fallback: @artifacta/mcp or artifacta-mcp)", () => {
    expect(["@artifacta-mcp/mcp", "@artifacta/mcp", "artifacta-mcp"]).toContain(pkg.name);
  });

  it("declares engines.node >=20.0.0", () => {
    expect(pkg.engines?.node).toBe(">=20.0.0");
  });

  it("declares bin.artifacta-mcp -> ./dist/cli.js", () => {
    expect(pkg.bin).toBeDefined();
    expect(pkg.bin?.["artifacta-mcp"]).toBe("./dist/cli.js");
  });

  it("type=module (ESM only per plan §8.1)", () => {
    expect(pkg.type).toBe("module");
  });

  it("files array contains only the 4 permitted entries", () => {
    expect(pkg.files).toBeDefined();
    const allowed = new Set(["dist", "README.md", "LICENSE", "CHANGELOG.md"]);
    for (const entry of pkg.files ?? []) {
      expect(allowed.has(entry)).toBe(true);
    }
    // Must include all four
    expect(pkg.files).toContain("dist");
    expect(pkg.files).toContain("README.md");
    expect(pkg.files).toContain("LICENSE");
    expect(pkg.files).toContain("CHANGELOG.md");
  });

  it("license is MIT", () => {
    expect(pkg.license).toBe("MIT");
  });

  it("publishConfig.access is public (scoped packages need this)", () => {
    expect(pkg.publishConfig?.access).toBe("public");
  });

  it("includes repository, homepage, and bugs metadata for npm listing", () => {
    expect(pkg.repository).toBeDefined();
    expect(pkg.homepage).toBeTruthy();
  });

  it("declares mcpName for MCP Registry ownership verification (AF_MCP-REG-3)", () => {
    expect(pkg.mcpName).toBe("io.artifacta/mcp");
  });

  it("declares the MCP SDK and required runtime dependencies", () => {
    expect(pkg.dependencies?.["@modelcontextprotocol/sdk"]).toBeTruthy();
    expect(pkg.dependencies?.["undici"]).toBeTruthy();
    expect(pkg.dependencies?.["smol-toml"]).toBeTruthy();
  });

  it("build script invokes tsc (no bundlers per plan §8.1)", () => {
    expect(pkg.scripts?.build).toBe("tsc");
  });

  it("prepublishOnly runs the build", () => {
    expect(pkg.scripts?.prepublishOnly).toContain("build");
  });
});

describe("AF_MCP-6.1 — distribution files present", () => {
  it("LICENSE file exists in package root", () => {
    expect(existsSync(join(ROOT, "LICENSE"))).toBe(true);
  });

  it("README.md exists and is non-empty", () => {
    const path = join(ROOT, "README.md");
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).size).toBeGreaterThan(0);
  });

  it("CHANGELOG.md exists in package root", () => {
    expect(existsSync(join(ROOT, "CHANGELOG.md"))).toBe(true);
  });

  it("README contains a Claude Desktop config snippet with -y and the package name", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf-8");
    expect(readme).toMatch(/claude_desktop_config\.json/);
    expect(readme).toMatch(/"-y"/);
    expect(readme).toContain("@artifacta-mcp/mcp");
    expect(readme).toMatch(/ARTIFACTA_API_KEY/);
  });

  it("README contains a Cursor config snippet", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf-8");
    expect(readme.toLowerCase()).toContain("cursor");
  });

  it("README contains an `unauthorized` troubleshooting section", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf-8");
    expect(readme.toLowerCase()).toMatch(/unauthorized/);
    expect(readme.toLowerCase()).toMatch(/troubleshoot/);
  });
});

describe("AF_MCP-6.1 — tsconfig produces ESM with sourcemaps", () => {
  interface TsConfig {
    compilerOptions?: {
      module?: string;
      target?: string;
      sourceMap?: boolean;
      outDir?: string;
    };
  }
  const tsconfig = readJson<TsConfig>(join(ROOT, "tsconfig.json"));

  it("module is NodeNext (ESM)", () => {
    expect(tsconfig.compilerOptions?.module).toBe("NodeNext");
  });

  it("sourceMap is true (so dist/ ships .js.map files)", () => {
    expect(tsconfig.compilerOptions?.sourceMap).toBe(true);
  });

  it("outDir is ./dist", () => {
    expect(tsconfig.compilerOptions?.outDir).toBe("./dist");
  });
});

describe.skipIf(WORKFLOWS_DIR === null)("AF_MCP-6.1 — CI / publish workflows", () => {
  const ci = join(WORKFLOWS_DIR ?? "", "mcp-typescript.yml");
  const publish = join(WORKFLOWS_DIR ?? "", "mcp-publish.yml");

  it("CI workflow exists at .github/workflows/mcp-typescript.yml", () => {
    expect(existsSync(ci)).toBe(true);
  });

  it("CI workflow runs tsc, vitest, and npm pack --dry-run", () => {
    const yml = readFileSync(ci, "utf-8");
    expect(yml).toMatch(/tsc --noEmit/);
    expect(yml).toMatch(/vitest run/);
    expect(yml).toMatch(/npm pack --dry-run/);
  });

  it("Publish workflow triggers on mcp-typescript-v* tags", () => {
    expect(existsSync(publish)).toBe(true);
    const yml = readFileSync(publish, "utf-8");
    expect(yml).toMatch(/mcp-typescript-v\*/);
    expect(yml).toMatch(/npm publish/);
    expect(yml).toMatch(/--access=public/);
  });
});
