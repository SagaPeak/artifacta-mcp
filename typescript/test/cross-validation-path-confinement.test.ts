import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { checkPath, closeSync } from "../src/path/confinement.js";

// Cross-validation against the shared fixture consumed by the Python engine
// at mcp/python/tests/test_path_confinement.py — both engines must produce
// the same accept/reject verdict for every fixture case (AF_MCP-6.2).
const FIXTURE_PATH = resolve(__dirname, "../../shared/path-confinement-fixture.json");

// closeSync is re-exported here only so the test compiles; the engine itself
// uses node:fs internally. Stub the re-export below.
function close(fd: number): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("node:fs").closeSync(fd);
}

interface FixtureCase {
  id: string;
  input_path: string;
  allow_roots: string[];
  verdict: "allow" | "deny";
  rule?: string;
}

interface Fixture {
  cases: FixtureCase[];
}

describe("cross-validation: shared path-confinement fixture (TS side)", () => {
  let workDir: string;

  beforeAll(() => {
    // Canonicalise via realpath so allow-list membership comparisons line up
    // with checkPath's internal realpathSync (macOS /var → /private/var).
    workDir = realpathSync(mkdtempSync(join(tmpdir(), "afmcp-xval-")));
  });

  function expand(s: string, tmpDir: string, regularFile: string): string {
    return s
      .replace("$CWD$", workDir)
      .replace("$HOME$", homedir())
      .replace("$TMP_REGULAR_FILE$", regularFile)
      .replace("$TMP_DIR$", tmpDir);
  }

  function materialize(c: FixtureCase): { inputPath: string; allowRoots: string[] } {
    const tmpDir = join(workDir, "fixture_tmp");
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
    const regularFile = join(tmpDir, "regular.txt");
    if (!existsSync(regularFile)) writeFileSync(regularFile, "hello\n");

    const inputPath = expand(c.input_path, tmpDir, regularFile);
    const allowRoots = c.allow_roots.map((r) => expand(r, tmpDir, regularFile));

    // For deny-pattern cases that reference files we control, write them.
    if (c.rule === "denylist_pattern" && !existsSync(inputPath)) {
      writeFileSync(inputPath, "seed\n");
    }

    return { inputPath, allowRoots };
  }

  const fixture: Fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));

  for (const c of fixture.cases) {
    it(`fixture case: ${c.id} → ${c.verdict}`, () => {
      const { inputPath, allowRoots } = materialize(c);
      const result = checkPath(inputPath, allowRoots);
      const actual = result.ok ? "allow" : "deny";
      expect(actual, `reason: ${result.ok ? "<allowed>" : result.reason}`).toBe(c.verdict);

      if (result.ok) {
        // Close the fd so the test doesn't leak descriptors.
        close(result.fd);
        return;
      }

      // Sanity-check the reason matches the named rule.
      if (c.rule === "outside_allow_list") {
        expect(result.reason).toContain("outside the MCP server's allow-list");
      } else if (c.rule === "denylist_root") {
        // Some deny roots get reported as "/etc" or "/private/etc" depending on macOS realpath behaviour.
        expect(result.reason).toMatch(/deny-list|\/etc|\.ssh|\.aws|\.netrc/);
      } else if (c.rule === "denylist_pattern") {
        expect(result.reason).toContain("pattern");
      } else if (c.rule === "unresolvable") {
        expect(result.reason).toContain("cannot be resolved");
      }
    });
  }
});

// Re-export so the import above doesn't get tree-shaken; vitest type checker
// is satisfied either way.
export { closeSync } from "node:fs";
