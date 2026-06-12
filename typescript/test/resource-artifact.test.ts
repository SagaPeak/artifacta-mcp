// AF_MCP-2.3 — artifacta://artifact/{artifact_id} resource template +
// resources/list recent-artifact enumeration.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ARTIFACT_RESOURCE_TEMPLATE,
  registerArtifactResource,
} from "../src/resources/artifact.js";
import {
  registerWhoamiResource,
  WHOAMI_RESOURCE_URI,
} from "../src/resources/whoami.js";
import {
  clearResourceRegistry,
  listResources,
  listResourceTemplates,
  matchResourceTemplate,
} from "../src/resources/registry.js";
import { fetchRecentArtifactResources } from "../src/resources/list-recent.js";
import {
  resetHttpClient,
  setHttpClient,
} from "../src/http/instance.js";
import type { ArtifactaHttpClient } from "../src/http/client.js";
import type { HttpResult } from "../src/http/types.js";

const VALID_ID = "art_AAAAAAAAAAAAAAAA";
const SECOND_ID = "art_BBBBBBBBBBBBBBBB";

const ARTIFACT_BODY = {
  artifact_id: VALID_ID,
  filename: "report.pdf",
  content_type: "application/pdf",
  size_bytes: 1234,
  content_hash: "sha256:abc",
  created_at: "2026-04-01T00:00:00Z",
};

let mockRequest: ReturnType<typeof vi.fn>;

function installFakeClient(): void {
  mockRequest = vi.fn();
  const fake = {
    request: (opts: unknown) => mockRequest(opts),
    setConfig: vi.fn(),
  } as unknown as ArtifactaHttpClient;
  setHttpClient(fake);
}

beforeEach(() => {
  clearResourceRegistry();
  resetHttpClient();
  installFakeClient();
  registerWhoamiResource();
  registerArtifactResource();
});

afterEach(() => {
  clearResourceRegistry();
  resetHttpClient();
  vi.restoreAllMocks();
});

// ─── Template registration (AF_MCP-2.3.09) ──────────────────────────────────

describe("AF_MCP-2.3 — artifact resource template", () => {
  it("AF_MCP-2.3.09: resources/templates/list contains artifacta://artifact/{artifact_id}", () => {
    const templates = listResourceTemplates();
    const entry = templates.find(
      (t) => t.uriTemplate === "artifacta://artifact/{artifact_id}"
    );
    expect(entry).toBeDefined();
    expect(entry!.mimeType).toBe("application/json");
    expect(entry!.name).toBe("artifact");
  });

  it("template URI matches a concrete artifact URI and extracts the id param", () => {
    const m = matchResourceTemplate(`artifacta://artifact/${VALID_ID}`);
    expect(m).toBeDefined();
    expect(m!.params.artifact_id).toBe(VALID_ID);
  });

  it("template does not match URIs that contain extra path segments", () => {
    expect(
      matchResourceTemplate(`artifacta://artifact/${VALID_ID}/bytes`)
    ).toBeUndefined();
    expect(matchResourceTemplate("artifacta://session/sess_1")).toBeUndefined();
    expect(matchResourceTemplate("artifacta://whoami")).toBeUndefined();
  });

  it("template description references the get_artifact tool", () => {
    expect(ARTIFACT_RESOURCE_TEMPLATE.description).toMatch(/get_artifact/);
  });
});

// ─── Template read (AF_MCP-2.3.10) ──────────────────────────────────────────

describe("AF_MCP-2.3 — artifacta://artifact/<id> read", () => {
  it("AF_MCP-2.3.10: resources/read returns the same JSON as the tool would", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: ARTIFACT_BODY,
    } satisfies HttpResult);

    const m = matchResourceTemplate(`artifacta://artifact/${VALID_ID}`)!;
    const result = await m.read(`artifacta://artifact/${VALID_ID}`, m.params);

    expect(result.contents).toHaveLength(1);
    const c = result.contents[0] as {
      uri: string;
      mimeType?: string;
      text: string;
    };
    expect(c.uri).toBe(`artifacta://artifact/${VALID_ID}`);
    expect(c.mimeType).toBe("application/json");
    expect(JSON.parse(c.text)).toEqual(ARTIFACT_BODY);

    const opts = mockRequest.mock.calls[0][0] as { path: string };
    expect(opts.path).toBe(`/v1/artifacts/${VALID_ID}`);
  });

  it("throws McpError on artifact_not_found", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: {
        code: "artifact_not_found",
        message: "Artifact not found",
        status: 404,
      },
      attempts: 1,
    } satisfies HttpResult);
    const m = matchResourceTemplate(`artifacta://artifact/${VALID_ID}`)!;
    await expect(
      m.read(`artifacta://artifact/${VALID_ID}`, m.params)
    ).rejects.toMatchObject({
      message: expect.stringContaining("does not exist"),
    });
  });

  it("throws McpError with translated text on artifact_expired", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: false,
      status: 410,
      error: { code: "artifact_expired", message: "expired", status: 410 },
      attempts: 1,
    } satisfies HttpResult);
    const m = matchResourceTemplate(`artifacta://artifact/${VALID_ID}`)!;
    await expect(
      m.read(`artifacta://artifact/${VALID_ID}`, m.params)
    ).rejects.toMatchObject({
      message: expect.stringMatching(/expired/i),
    });
  });
});

// ─── resources/list — recent enumeration (AF_MCP-2.3.11, 2.3.12) ─────────────

describe("AF_MCP-2.3 — fetchRecentArtifactResources", () => {
  it("AF_MCP-2.3.11: enumerates up to 20 recent artifacts as Resource entries", async () => {
    const artifacts = [
      { artifact_id: VALID_ID, filename: "report.pdf", created_at: "2026-04-02" },
      { artifact_id: SECOND_ID, filename: "trace.json", created_at: "2026-04-01" },
    ];
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { artifacts, next_cursor: null, has_more: false },
    } satisfies HttpResult);

    const recent = await fetchRecentArtifactResources();
    expect(recent).toHaveLength(2);
    expect(recent[0].uri).toBe(`artifacta://artifact/${VALID_ID}`);
    expect(recent[0].name).toBe("report.pdf");
    expect(recent[0].mimeType).toBe("application/json");
    expect(recent[1].uri).toBe(`artifacta://artifact/${SECOND_ID}`);
    expect(recent[1].name).toBe("trace.json");
  });

  it("AF_MCP-2.3.12: passes limit=20 to list_artifacts (newest-first comes from API)", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { artifacts: [], next_cursor: null, has_more: false },
    } satisfies HttpResult);
    await fetchRecentArtifactResources();
    const opts = mockRequest.mock.calls[0][0] as {
      method: string;
      path: string;
    };
    expect(opts.method).toBe("GET");
    expect(opts.path).toBe("/v1/artifacts?limit=20");
  });

  it("returns empty array (fail-soft) when the API call fails", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: false,
      status: 401,
      error: { code: "unauthorized", message: "x", status: 401 },
      attempts: 1,
    } satisfies HttpResult);
    const recent = await fetchRecentArtifactResources();
    expect(recent).toEqual([]);
  });

  it("returns empty array when the http client throws", async () => {
    mockRequest.mockRejectedValueOnce(new Error("boom"));
    const recent = await fetchRecentArtifactResources();
    expect(recent).toEqual([]);
  });

  it("falls back to artifact_id when filename is missing", async () => {
    mockRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: {
        artifacts: [{ artifact_id: VALID_ID }],
        next_cursor: null,
        has_more: false,
      },
    } satisfies HttpResult);
    const recent = await fetchRecentArtifactResources();
    expect(recent[0].name).toBe(VALID_ID);
  });
});

// ─── Static + dynamic merge — sanity check ──────────────────────────────────

describe("AF_MCP-2.3 — resources/list shape", () => {
  it("static listResources() always includes whoami (template list is separate)", () => {
    const statics = listResources();
    expect(statics.map((r) => r.uri)).toContain(WHOAMI_RESOURCE_URI);
  });
});
