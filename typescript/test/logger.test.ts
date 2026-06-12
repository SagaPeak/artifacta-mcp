import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  logger,
  setLogLevel,
  getLogLevel,
  setLogWriter,
  resetLogger,
  isLogLevel,
  DEFAULT_LOG_LEVEL,
  LOG_LEVELS,
} from "../src/log/logger.js";

describe("logger — levels, JSON shape, stderr destination", () => {
  let captured: string[] = [];

  beforeEach(() => {
    resetLogger();
    captured = [];
    setLogWriter((line) => captured.push(line));
  });

  afterEach(() => {
    resetLogger();
  });

  it("default level is `notice`", () => {
    expect(getLogLevel()).toBe("notice");
    expect(DEFAULT_LOG_LEVEL).toBe("notice");
  });

  it("supports the 8 MCP levels in order", () => {
    expect(LOG_LEVELS).toEqual([
      "debug",
      "info",
      "notice",
      "warning",
      "error",
      "critical",
      "alert",
      "emergency",
    ]);
  });

  it("isLogLevel guards invalid strings", () => {
    expect(isLogLevel("debug")).toBe(true);
    expect(isLogLevel("emergency")).toBe(true);
    expect(isLogLevel("verbose")).toBe(false);
    expect(isLogLevel("")).toBe(false);
    expect(isLogLevel(undefined)).toBe(false);
    expect(isLogLevel(42)).toBe(false);
  });

  it("emits notice and above by default; suppresses debug/info", () => {
    logger.debug("d");
    logger.info("i");
    logger.notice("n");
    logger.warning("w");
    logger.error("e");
    expect(captured).toHaveLength(3);
    const levels = captured.map((line) => (JSON.parse(line) as { level: string }).level);
    expect(levels).toEqual(["notice", "warning", "error"]);
  });

  it("setLogLevel('debug') unblocks lower levels at runtime", () => {
    setLogLevel("debug");
    logger.debug("d");
    logger.info("i");
    logger.notice("n");
    expect(captured).toHaveLength(3);
    expect((JSON.parse(captured[0]) as { level: string }).level).toBe("debug");
  });

  it("setLogLevel('error') suppresses notice/warning", () => {
    setLogLevel("error");
    logger.notice("n");
    logger.warning("w");
    logger.error("e");
    logger.critical("c");
    expect(captured).toHaveLength(2);
    const levels = captured.map((line) => (JSON.parse(line) as { level: string }).level);
    expect(levels).toEqual(["error", "critical"]);
  });

  it("emits single-line JSON with ts (ISO), level, msg keys", () => {
    setLogLevel("debug");
    logger.notice("hello", { tool: "whoami", request_id: "abc-123" });
    expect(captured).toHaveLength(1);
    expect(captured[0]).not.toContain("\n");
    const parsed = JSON.parse(captured[0]) as Record<string, unknown>;
    expect(typeof parsed.ts).toBe("string");
    expect(new Date(parsed.ts as string).toISOString()).toBe(parsed.ts);
    expect(parsed.level).toBe("notice");
    expect(parsed.msg).toBe("hello");
    expect(parsed.tool).toBe("whoami");
    expect(parsed.request_id).toBe("abc-123");
  });

  it("does not include undefined extras in the JSON", () => {
    logger.notice("no-extras", { tool: undefined, request_id: undefined });
    const parsed = JSON.parse(captured[0]) as Record<string, unknown>;
    expect("tool" in parsed).toBe(false);
    expect("request_id" in parsed).toBe(false);
  });

  it("default writer targets stderr, never stdout", () => {
    resetLogger(); // restore default writer
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    logger.notice("stderr-check");
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stdoutSpy).not.toHaveBeenCalled();
    const written = stderrSpy.mock.calls[0][0];
    expect(typeof written).toBe("string");
    expect(written).toMatch(/^\{.*"level":"notice".*\}\n$/);
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });
});
