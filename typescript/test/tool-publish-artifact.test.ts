// Task 9 — publish_artifact tool (TS).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { clearRegistry, getToolRegistration } from "../src/safety/registry.js";
import { resetHttpClient, setHttpClient } from "../src/http/instance.js";
import type { ArtifactaHttpClient } from "../src/http/client.js";
import type { HttpResult } from "../src/http/types.js";
import {
  PUBLISH_ARTIFACT_TOOL,
  publishArtifactHandler,
  registerPublishArtifactTool,
} from "../src/tools/publish-artifact.js";

let mockRequest: ReturnType<typeof vi.fn>;

function installFakeClient(): void {
  mockRequest = vi.fn();
  const fake = {
    request: (opts: unknown) => mockRequest(opts),
    setConfig: vi.fn(),
  } as unknown as ArtifactaHttpClient;
  setHttpClient(fake);
}

function okResult(data: Record<string, unknown>): HttpResult {
  return { ok: true, status: 200, data };
}

function failResult(code: string, status: number, message = "boom"): HttpResult {
  return { ok: false, status, error: { code, message, status }, attempts: 1 };
}

beforeEach(() => {
  clearRegistry();
  resetHttpClient();
  installFakeClient();
  registerPublishArtifactTool();
});

afterEach(() => {
  clearRegistry();
  resetHttpClient();
  vi.restoreAllMocks();
});

// ─── Registration + schema ────────────────────────────────────────────────────

describe("publish_artifact — registration", () => {
  it("registers 'publish_artifact' with safety 'writeIdempotent'", () => {
    const reg = getToolRegistration("publish_artifact");
    expect(reg).toBeDefined();
    expect(reg!.tool.name).toBe("publish_artifact");
    expect(reg!.safety).toBe("writeIdempotent");
    expect(reg!.alwaysConfirm).toBe(false);
  });

  it("schema has NO password property", () => {
    const props = (PUBLISH_ARTIFACT_TOOL.inputSchema as Record<string, unknown>).properties as Record<string, unknown>;
    expect(props.password).toBeUndefined();
    expect(props.artifact_id).toBeDefined();
  });

  it("schema requires only artifact_id and disallows additional properties", () => {
    const schema = PUBLISH_ARTIFACT_TOOL.inputSchema as Record<string, unknown>;
    expect(schema.required).toEqual(["artifact_id"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("schema includes visibility and access enum properties", () => {
    const props = (PUBLISH_ARTIFACT_TOOL.inputSchema as Record<string, unknown>).properties as Record<string, Record<string, unknown>>;
    expect((props.visibility as Record<string, unknown>).enum).toEqual(["unlisted", "public"]);
    expect((props.access as Record<string, unknown>).enum).toEqual(["none", "password"]);
  });
});

// ─── Handler ─────────────────────────────────────────────────────────────────

describe("publish_artifact — handler", () => {
  it("POSTs to /v1/artifacts/{id}/publish and returns public_url", async () => {
    mockRequest.mockResolvedValueOnce(
      okResult({ page_id: "pg_x", public_url: "https://artifacta.io/a/pg_x", visibility: "unlisted", access: "none" })
    );
    const result = await publishArtifactHandler({ artifact_id: "art_x" });
    expect(result.isError).toBeUndefined();
    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({ method: "POST", path: "/v1/artifacts/art_x/publish" })
    );
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("https://artifacta.io/a/pg_x");
  });

  it("uses idempotentWrite retry policy", async () => {
    mockRequest.mockResolvedValueOnce(
      okResult({ page_id: "pg_y", public_url: "https://artifacta.io/a/pg_y", visibility: "unlisted", access: "none" })
    );
    await publishArtifactHandler({ artifact_id: "art_y" });
    expect(mockRequest.mock.calls[0][0].retryPolicy).toBe("idempotentWrite");
  });

  it("defaults visibility to 'unlisted' and access to 'none'", async () => {
    mockRequest.mockResolvedValueOnce(
      okResult({ page_id: "pg_z", public_url: "https://artifacta.io/a/pg_z", visibility: "unlisted", access: "none" })
    );
    await publishArtifactHandler({ artifact_id: "art_z" });
    const body = mockRequest.mock.calls[0][0].body;
    expect(body.visibility).toBe("unlisted");
    expect(body.access).toBe("none");
    expect(body.title).toBeUndefined();
  });

  it("forwards optional title when provided", async () => {
    mockRequest.mockResolvedValueOnce(
      okResult({ page_id: "pg_a", public_url: "https://artifacta.io/a/pg_a", visibility: "unlisted", access: "none" })
    );
    await publishArtifactHandler({ artifact_id: "art_a", title: "My Page" });
    expect(mockRequest.mock.calls[0][0].body.title).toBe("My Page");
  });

  it("missing artifact_id → invalid_request, no API call", async () => {
    const result = await publishArtifactHandler({});
    expect(result.isError).toBe(true);
    expect((result._meta as { code: string }).code).toBe("invalid_request");
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("non-string artifact_id → invalid_request, no API call", async () => {
    const result = await publishArtifactHandler({ artifact_id: 42 });
    expect(result.isError).toBe(true);
    expect((result._meta as { code: string }).code).toBe("invalid_request");
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("translates API failure to MCP error shape", async () => {
    mockRequest.mockResolvedValueOnce(failResult("artifact_not_found", 404, "not found"));
    const result = await publishArtifactHandler({ artifact_id: "art_x" });
    expect(result.isError).toBe(true);
    expect((result._meta as { code: string }).code).toBe("artifact_not_found");
  });
});
