// Task 9 — unpublish_artifact tool (TS).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { clearRegistry, getToolRegistration } from "../src/safety/registry.js";
import { resetHttpClient, setHttpClient } from "../src/http/instance.js";
import type { ArtifactaHttpClient } from "../src/http/client.js";
import type { HttpResult } from "../src/http/types.js";
import {
  UNPUBLISH_ARTIFACT_TOOL,
  unpublishArtifactHandler,
  registerUnpublishArtifactTool,
} from "../src/tools/unpublish-artifact.js";

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
  registerUnpublishArtifactTool();
});

afterEach(() => {
  clearRegistry();
  resetHttpClient();
  vi.restoreAllMocks();
});

// ─── Registration + schema ────────────────────────────────────────────────────

describe("unpublish_artifact — registration", () => {
  it("registers 'unpublish_artifact' with safety 'writeIdempotent'", () => {
    const reg = getToolRegistration("unpublish_artifact");
    expect(reg).toBeDefined();
    expect(reg!.tool.name).toBe("unpublish_artifact");
    expect(reg!.safety).toBe("writeIdempotent");
    expect(reg!.alwaysConfirm).toBe(false);
  });

  it("schema requires only artifact_id and disallows additional properties", () => {
    const schema = UNPUBLISH_ARTIFACT_TOOL.inputSchema as Record<string, unknown>;
    expect(schema.required).toContain("artifact_id");
    expect(schema.additionalProperties).toBe(false);
  });
});

// ─── Handler ─────────────────────────────────────────────────────────────────

describe("unpublish_artifact — handler", () => {
  it("DELETEs to /v1/artifacts/{id}/publish and returns result", async () => {
    mockRequest.mockResolvedValueOnce(
      okResult({ page_id: "pg_x", unpublished: true })
    );
    const result = await unpublishArtifactHandler({ artifact_id: "art_x" });
    expect(result.isError).toBeUndefined();
    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({ method: "DELETE", path: "/v1/artifacts/art_x/publish" })
    );
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("pg_x");
  });

  it("uses idempotentWrite retry policy", async () => {
    mockRequest.mockResolvedValueOnce(okResult({ page_id: "pg_y", unpublished: true }));
    await unpublishArtifactHandler({ artifact_id: "art_y" });
    expect(mockRequest.mock.calls[0][0].retryPolicy).toBe("idempotentWrite");
  });

  it("missing artifact_id → invalid_request, no API call", async () => {
    const result = await unpublishArtifactHandler({});
    expect(result.isError).toBe(true);
    expect((result._meta as { code: string }).code).toBe("invalid_request");
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("non-string artifact_id → invalid_request, no API call", async () => {
    const result = await unpublishArtifactHandler({ artifact_id: 123 });
    expect(result.isError).toBe(true);
    expect((result._meta as { code: string }).code).toBe("invalid_request");
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("translates API failure to MCP error shape", async () => {
    mockRequest.mockResolvedValueOnce(failResult("artifact_not_found", 404));
    const result = await unpublishArtifactHandler({ artifact_id: "art_x" });
    expect(result.isError).toBe(true);
    expect((result._meta as { code: string }).code).toBe("artifact_not_found");
  });
});
