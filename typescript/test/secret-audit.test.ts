import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SECRET_PATTERNS,
  auditDirectory,
  listTranscriptFiles,
  parseArgs,
  scanText,
} from "../scripts/secret-audit.js";

// A realistic Artifacta key shape: ak_live_ + exactly 32 alnum chars.
const FAKE_AK_LIVE = `ak_live_${"a1B2c3D4".repeat(4)}`; // 32 chars tail

describe("AF_MCP-7.3 secret-audit — pattern coverage", () => {
  it("7.3.03 — clean transcript text yields zero findings", () => {
    const text = [
      "User: What artifacts did agent build-bot produce yesterday?",
      "Assistant: I'll call whoami, then list_artifacts(agent_id=build-bot, created_after=2026-05-24).",
      "Tool result: 3 artifacts found. Summary: report.pdf, metrics.json, log.txt.",
    ].join("\n");
    expect(scanText(text)).toHaveLength(0);
  });

  it("7.3.13 — flags ak_live_ + 32 alphanumeric chars", () => {
    const findings = scanText(`leaked key: ${FAKE_AK_LIVE} oops`);
    expect(findings.some((f) => f.pattern.includes("ak_live_"))).toBe(true);
  });

  it("7.3.14 — flags PEM private-key markers (RSA/OPENSSH/DSA/EC/PGP)", () => {
    for (const marker of [
      "BEGIN RSA PRIVATE KEY",
      "BEGIN OPENSSH PRIVATE KEY",
      "BEGIN DSA PRIVATE KEY",
      "BEGIN EC PRIVATE KEY",
      "BEGIN PGP PRIVATE KEY",
    ]) {
      const findings = scanText(`-----${marker}-----`);
      expect(findings.length).toBeGreaterThan(0);
    }
  });

  it("7.3.15 — flags AWS access key id shape (AKIA + 16 upper/num)", () => {
    const findings = scanText("aws: AKIA1234567890ABCDEF used");
    expect(findings.some((f) => f.pattern.includes("AWS"))).toBe(true);
  });

  it("7.3.16 — flags GitHub token shapes (ghp_/gho_/ghu_/ghs_ + 36)", () => {
    for (const prefix of ["ghp", "gho", "ghu", "ghs"]) {
      const token = `${prefix}_${"A1b2C3d4".repeat(4)}wxyz`; // 36-char tail
      const findings = scanText(`token=${token}`);
      expect(findings.some((f) => f.pattern.includes("GitHub"))).toBe(true);
    }
  });

  it("7.3.17 — flags `Bearer ak_live_`", () => {
    const findings = scanText("Authorization: Bearer ak_live_xxx");
    expect(findings.some((f) => f.pattern.includes("Bearer"))).toBe(true);
  });

  it("does NOT flag filename-shaped tokens (id_rsa, credentials, .env)", () => {
    const text = "Agent referenced id_rsa, credentials.json, and .env but printed no contents.";
    expect(scanText(text)).toHaveLength(0);
  });

  it("reports 1-based line and column without echoing the secret value", () => {
    const text = `line one\nleak ${FAKE_AK_LIVE}`;
    const [finding] = scanText(text);
    expect(finding.line).toBe(2);
    expect(finding.column).toBe(6);
    expect(Object.values(finding).join(" ")).not.toContain(FAKE_AK_LIVE);
  });
});

describe("AF_MCP-7.3 secret-audit — per-scenario allowlist", () => {
  it("7.3.18 — --allow path string is suppressed, but PEM content is STILL flagged", () => {
    const text = [
      "User: store ~/.ssh/id_rsa via store_artifact.path",
      "Server: refused — ~/.ssh is a denied location (§4.4).",
      "(a planted leak) -----BEGIN RSA PRIVATE KEY-----",
    ].join("\n");

    const findings = scanText(text, ["~/.ssh/id_rsa"]);
    // The benign path reference produced no finding to begin with, and the allow entry does
    // not mask the PEM marker, which is not a substring of the allow value.
    expect(findings.some((f) => f.pattern.includes("PEM RSA"))).toBe(true);
  });

  it("allow masking suppresses a credential that is a substring of an allow value", () => {
    const text = `expected fixture key: ${FAKE_AK_LIVE}`;
    expect(scanText(text)).toHaveLength(1);
    expect(scanText(text, [FAKE_AK_LIVE])).toHaveLength(0);
  });

  it("allow masking is exact and does not suppress a different key", () => {
    const other = `ak_live_${"Z9y8X7w6".repeat(4)}`;
    const text = `key: ${other}`;
    expect(scanText(text, [FAKE_AK_LIVE])).toHaveLength(1);
  });
});

describe("AF_MCP-7.3 secret-audit — directory walk", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "secret-audit-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips .gitkeep and returns clean on an empty transcript dir", () => {
    writeFileSync(join(dir, ".gitkeep"), "");
    expect(listTranscriptFiles(dir)).toHaveLength(0);
    const result = auditDirectory(dir);
    expect(result.filesScanned).toBe(0);
    expect(result.findings).toHaveLength(0);
  });

  it("scans nested transcript files and reports findings with file path", () => {
    const sub = join(dir, "phase-07");
    mkdirSync(sub);
    writeFileSync(join(sub, "clean.md"), "no secrets here");
    writeFileSync(join(sub, "leak.txt"), `Bearer ak_live_ token spotted`);

    const result = auditDirectory(dir);
    expect(result.filesScanned).toBe(2);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings.every((f) => f.file.includes(dir))).toBe(true);
  });

  it("throws on a missing directory (CLI maps to exit 2)", () => {
    expect(() => auditDirectory(join(dir, "does-not-exist"))).toThrow();
  });
});

describe("AF_MCP-7.3 secret-audit — arg parsing", () => {
  it("parses a positional dir", () => {
    expect(parseArgs(["transcripts/"]).dir).toBe("transcripts/");
  });

  it("collects repeatable --allow values (space and =) ", () => {
    const parsed = parseArgs(["t/", "--allow", "~/.ssh/id_rsa", "--allow=foo"]);
    expect(parsed.allow).toEqual(["~/.ssh/id_rsa", "foo"]);
  });

  it("--help sets the help flag", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
  });

  it("throws on --allow without a value and on unknown flags", () => {
    expect(() => parseArgs(["t/", "--allow"])).toThrow();
    expect(() => parseArgs(["t/", "--bogus"])).toThrow();
  });

  it("SECRET_PATTERNS covers all nine AF_MCP-7.3 credential shapes", () => {
    expect(SECRET_PATTERNS).toHaveLength(9);
  });
});
