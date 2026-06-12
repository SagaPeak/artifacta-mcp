// AF_MCP-7.2 — Structural / scaffolding cases.
//
// These verify the integration-suite scaffold itself is wired:
//   - 7.2.01 / 7.2.02 — nightly workflow file present + posts a results artifact
//   - 7.2.03 / 7.2.04 — required test files exist with the expected shape
//   - 7.2.24          — non-retry subsuite uses the local stub, not staging
//   - 7.2.25          — transport mode is parameterized, not hard-coded

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const NIGHTLY_WORKFLOW = join(
  REPO_ROOT,
  ".github",
  "workflows",
  "mcp-integration-nightly.yml"
);
const INTEGRATION_DIR = join(__dirname);

describe("AF_MCP-7.2 scaffolding — workflow + file shape", () => {
  it("AF_MCP-7.2.01 — nightly workflow file exists with schedule trigger", () => {
    expect(existsSync(NIGHTLY_WORKFLOW)).toBe(true);
    const yaml = readFileSync(NIGHTLY_WORKFLOW, "utf8");
    // YAML "on:" block must declare `schedule:` with at least one cron entry.
    expect(yaml).toMatch(/^\s*schedule:\s*$/m);
    expect(yaml).toMatch(/cron:\s*['"][^'"]+['"]/);
  });

  it("AF_MCP-7.2.02 — workflow uploads a results artifact for the dashboard", () => {
    const yaml = readFileSync(NIGHTLY_WORKFLOW, "utf8");
    // Must invoke an upload step so the dashboard / tracking surface can ingest
    // results. We accept either `actions/upload-artifact@vN` (canonical) or any
    // explicit `# results-dashboard:` marker for future re-pointing at a webhook.
    const usesUpload = /uses:\s*actions\/upload-artifact@/i.test(yaml);
    const hasMarker = /#\s*results-dashboard:/i.test(yaml);
    expect(usesUpload || hasMarker).toBe(true);
  });

  it("AF_MCP-7.2.03 — per-tool happy-path test file exists with cases for shipped tools", () => {
    const path = join(INTEGRATION_DIR, "per-tool-happy.test.ts");
    expect(existsSync(path)).toBe(true);
    const src = readFileSync(path, "utf8");
    for (const tool of [
      "whoami",
      "list_artifacts",
      "get_artifact",
      "get_artifact_download_url",
      "list_sessions",
    ]) {
      expect(src).toContain(tool);
    }
  });

  it("AF_MCP-7.2.04 — error-code test file covers all 12 codes from CLAUDE.md taxonomy", () => {
    const path = join(INTEGRATION_DIR, "per-error-code.test.ts");
    expect(existsSync(path)).toBe(true);
    const src = readFileSync(path, "utf8");
    const taxonomy = [
      "invalid_request",
      "unauthorized",
      "quota_exceeded",
      "ttl_exceeds_plan_limit",
      "artifact_not_found",
      "session_not_found",
      "session_sealed",
      "artifact_expired",
      "artifact_already_deleted",
      "file_too_large",
      "rate_limited",
      "upload_not_found",
    ];
    for (const code of taxonomy) {
      expect(src).toContain(code);
    }
  });

  it("AF_MCP-7.2.24 — non-retry subsuite uses the local stub, not staging", () => {
    const path = join(INTEGRATION_DIR, "non-retry-ambiguous-completion.test.ts");
    expect(existsSync(path)).toBe(true);
    const src = readFileSync(path, "utf8");
    // The stub-server module is the contract for synthetic 5xx (per task notes).
    expect(src).toContain("stub-server");
    // Must NOT depend on STAGING_KEY for the 502 cases — those run on every CI.
    expect(src).not.toMatch(/skipIf\(\s*!?\s*hasStaging\(\)\s*\).*502/s);
  });

  it("AF_MCP-7.2.25 — transport mode is parameterized via _setup.ts, not hard-coded", () => {
    const path = join(INTEGRATION_DIR, "_setup.ts");
    expect(existsSync(path)).toBe(true);
    const src = readFileSync(path, "utf8");
    expect(src).toContain("export type Transport");
    expect(src).toContain("TRANSPORTS");
    // Confirms env-var override path: future SSE phase passes
    // `ARTIFACTA_MCP_INTEGRATION_TRANSPORTS=sse` without code change.
    expect(src).toContain("ARTIFACTA_MCP_INTEGRATION_TRANSPORTS");
  });
});
