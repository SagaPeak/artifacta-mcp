import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  containsAnyForbidden,
  assertSafeTelemetry,
} from "../src/telemetry/redact.js";
import {
  ALLOWED_TELEMETRY_FIELDS,
  emitTelemetry,
  resetTelemetry,
  setTelemetryMode,
  setTelemetryTransport,
} from "../src/telemetry/emitter.js";

describe("telemetry redaction guard", () => {
  it("flags an exact API-key match in any field", () => {
    const apiKey = "ak_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const result = containsAnyForbidden(
      { tool_name: "whoami", server_version: `0.1.0 ${apiKey}` },
      [apiKey]
    );
    expect(result.found).toBe(true);
    expect(result.field).toBe("server_version");
    expect(result.needle).toBe(apiKey);
  });

  it("flags a tool-argument value in any field", () => {
    const artifactId = "art_abc123def456ghij";
    const result = containsAnyForbidden(
      { tool_name: `dispatched_${artifactId}` },
      [artifactId]
    );
    expect(result.found).toBe(true);
  });

  it("flags response-body strings in any field", () => {
    const tenantName = "AcmeCorpInternal";
    const result = containsAnyForbidden(
      { tool_name: "whoami", note: tenantName },
      [tenantName]
    );
    expect(result.found).toBe(true);
  });

  it("returns clean for empty needles", () => {
    const result = containsAnyForbidden(
      { tool_name: "whoami", server_version: "0.1.0" },
      ["", "   "]
    );
    // empty needles are skipped; whitespace-only strings are not skipped, but
    // unlikely to match real fields.
    expect(result.found).toBe(false);
  });

  it("ignores undefined/null payload values", () => {
    const result = containsAnyForbidden(
      { tool_name: "whoami", error_code: undefined as unknown as string, missing: null },
      ["whoami"]
    );
    expect(result.found).toBe(true);
    expect(result.field).toBe("tool_name");
  });

  it("assertSafeTelemetry throws on leak with field + needle in message", () => {
    expect(() =>
      assertSafeTelemetry(
        { tool_name: "leaked-secret-123" },
        ["secret-123"]
      )
    ).toThrow(/leaked forbidden substring "secret-123" in field "tool_name"/);
  });

  it("assertSafeTelemetry passes for clean payload", () => {
    expect(() =>
      assertSafeTelemetry(
        { tool_name: "whoami", latency_ms: 42, success: true, server_version: "0.1.0" },
        ["secret", "token", "ak_live_xxxxxxxx"]
      )
    ).not.toThrow();
  });
});

describe("emitTelemetry — payload shape and redaction invariant", () => {
  let captured: string[] = [];

  beforeEach(() => {
    resetTelemetry();
    captured = [];
    setTelemetryTransport((line) => captured.push(line));
  });

  afterEach(() => {
    resetTelemetry();
  });

  it("is off by default — no emit even when called", () => {
    emitTelemetry({
      tool_name: "whoami",
      latency_ms: 5,
      success: true,
      server_version: "0.1.0",
    });
    expect(captured).toHaveLength(0);
  });

  it("emits a JSON line when on", () => {
    setTelemetryMode("on");
    emitTelemetry({
      tool_name: "whoami",
      latency_ms: 5,
      success: true,
      server_version: "0.1.0",
    });
    expect(captured).toHaveLength(1);
    const parsed = JSON.parse(captured[0]) as Record<string, unknown>;
    expect(parsed.tool_name).toBe("whoami");
    expect(parsed.latency_ms).toBe(5);
    expect(parsed.success).toBe(true);
    expect(parsed.server_version).toBe("0.1.0");
  });

  it("payload contains exactly the 5 allow-listed keys (or fewer if error_code absent)", () => {
    setTelemetryMode("on");
    emitTelemetry({
      tool_name: "list_artifacts",
      latency_ms: 12,
      success: false,
      error_code: "artifact_not_found",
      server_version: "0.1.0",
    });
    const parsed = JSON.parse(captured[0]) as Record<string, unknown>;
    const keys = Object.keys(parsed).sort();
    for (const k of keys) {
      expect(ALLOWED_TELEMETRY_FIELDS).toContain(k as keyof typeof parsed);
    }
    expect(keys).toContain("tool_name");
    expect(keys).toContain("latency_ms");
    expect(keys).toContain("success");
    expect(keys).toContain("error_code");
    expect(keys).toContain("server_version");
    expect(keys).toHaveLength(5);
  });

  it("drops any key not on the allow-list (defensive sanitization)", () => {
    setTelemetryMode("on");
    // Caller forces an extra field via cast; the emitter must drop it.
    const badPayload = {
      tool_name: "whoami",
      latency_ms: 1,
      success: true,
      server_version: "0.1.0",
      // Forbidden:
      arguments: { artifact_id: "art_LEAK" },
      response_body: { tenant_name: "LEAK_TENANT" },
      api_key: "ak_live_LEAK",
    } as unknown as Parameters<typeof emitTelemetry>[0];
    emitTelemetry(badPayload);
    const parsed = JSON.parse(captured[0]) as Record<string, unknown>;
    expect(parsed.arguments).toBeUndefined();
    expect(parsed.response_body).toBeUndefined();
    expect(parsed.api_key).toBeUndefined();

    // Tripwire: no forbidden substring leaked
    assertSafeTelemetry(parsed, [
      "art_LEAK",
      "LEAK_TENANT",
      "ak_live_LEAK",
    ]);
  });

  it("does not include API key, argument values, or response body strings", () => {
    setTelemetryMode("on");
    // Telemetry is constructed from server-controlled fields only; this
    // happy-path emit must not contain any of the three forbidden classes.
    emitTelemetry({
      tool_name: "get_artifact",
      latency_ms: 7,
      success: true,
      server_version: "0.1.0",
    });
    const parsed = JSON.parse(captured[0]) as Record<string, unknown>;

    const forbidden = [
      "ak_live_secretkeyabcdefghij1234567890abcd", // example API key
      "art_userArgumentValue1",                      // example tool-argument value
      "Acme Corp Inc.",                              // example response-body string
      "ARTIFACTA_API_KEY",
    ];
    assertSafeTelemetry(parsed, forbidden);
  });

  it("never throws when transport throws (shielded)", () => {
    setTelemetryMode("on");
    setTelemetryTransport(() => {
      throw new Error("disk full");
    });
    expect(() =>
      emitTelemetry({
        tool_name: "whoami",
        latency_ms: 1,
        success: true,
        server_version: "0.1.0",
      })
    ).not.toThrow();
  });
});
