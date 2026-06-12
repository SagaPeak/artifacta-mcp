// AF_MCP-7.2.09–11 — Non-retry / ambiguous-completion subsuite.
//
// Per plan §6.1 and the QA spec: when a non-idempotent write endpoint
// (`request_upload_url`, `create_download_link`) returns 5xx, the MCP server
// must NOT auto-retry, and the surfaced error must carry the §6.1
// ambiguous-completion guidance text. A blind retry would risk creating a
// duplicate record.
//
// This subsuite uses the local `stub-server` — staging would not reliably
// produce a 502, so the stub is the only deterministic source.
//
// Architecture: drive `ArtifactaHttpClient` directly against the stub origin,
// then translate the failure with `translateHttpFailure()` and inspect the
// result the tool layer would surface. The HTTP client + translate layer is
// the contract; future Phase-6 tools wrap exactly this path.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ArtifactaHttpClient } from "../../src/http/client.js";
import { translateHttpFailure } from "../../src/errors/translate.js";
import { startStubServer, type StartedStub } from "./stub-server.js";

let stub: StartedStub;

const make502 = () => ({
  status: 502,
  body: JSON.stringify({
    error: {
      code: "server_error",
      message: "Bad gateway",
      status: 502,
    },
  }),
});

beforeEach(async () => {
  stub = await startStubServer({
    "POST /v1/artifacts/upload-url": () => make502(),
    "POST /v1/links": () => make502(),
  });
});

afterEach(async () => {
  await stub.close();
});

function makeClient(): ArtifactaHttpClient {
  return new ArtifactaHttpClient({
    apiKey: "ak_live_test00000000000000000000000000000000",
    apiUrl: stub.url,
  });
}

describe("AF_MCP-7.2.09 — `request_upload_url` 502 produces exactly 1 HTTP call", () => {
  it("retryPolicy=nonIdempotentWrite does not retry 5xx", async () => {
    const client = makeClient();
    const result = await client.request({
      method: "POST",
      path: "/v1/artifacts/upload-url",
      body: { filename: "x.bin", content_hash: "sha256:dead", size_bytes: 1 },
      retryPolicy: "nonIdempotentWrite",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // attempts === 1 means: dispatched once, surfaced once, no retry.
    expect(result.attempts).toBe(1);
    expect(result.ambiguousCompletion).toBe(true);
    // Mirror check at the wire layer.
    const uploadUrlCalls = stub.requestLog.filter(
      (r) => r.path === "/v1/artifacts/upload-url" && r.method === "POST"
    );
    expect(uploadUrlCalls.length).toBe(1);
  });
});

describe("AF_MCP-7.2.10 — `request_upload_url` error carries ambiguous-completion guidance", () => {
  it("translateHttpFailure surfaces the §6.1 verbatim guidance", async () => {
    const client = makeClient();
    const result = await client.request({
      method: "POST",
      path: "/v1/artifacts/upload-url",
      body: {},
      retryPolicy: "nonIdempotentWrite",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const translated = translateHttpFailure(result, "request_upload_url");
    expect(translated.isError).toBe(true);
    const text = translated.content.map((c) => c.text).join("\n");
    expect(text).toContain("Artifacta API failed mid-write on request_upload_url");
    expect(text).toContain("call list_artifacts with the same session_id/agent_id");
    expect(text).toContain("Retrying without checking risks creating a duplicate");
    const meta = translated._meta;
    expect(meta.retry_hint).toBe("do_not_retry");
  });
});

describe("AF_MCP-7.2.11 — `create_download_link` 502 produces exactly 1 HTTP call", () => {
  it("/v1/links is non-idempotent; same no-retry semantics; tool-name routes guidance", async () => {
    const client = makeClient();
    const result = await client.request({
      method: "POST",
      path: "/v1/links",
      body: { artifact_id: "art_aaaaaaaaaaaaaaaa", expires_in: 3600 },
      retryPolicy: "nonIdempotentWrite",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.attempts).toBe(1);
    expect(result.ambiguousCompletion).toBe(true);
    const linkCalls = stub.requestLog.filter(
      (r) => r.path === "/v1/links" && r.method === "POST"
    );
    expect(linkCalls.length).toBe(1);

    // Translate with the create_download_link tool name — the §6.1 guidance
    // re-routes the "before retrying" hint to the link-specific branch.
    const translated = translateHttpFailure(result, "create_download_link");
    const text = translated.content.map((c) => c.text).join("\n");
    expect(text).toContain("Artifacta API failed mid-write on create_download_link");
    expect(text).toContain("there is no list-links API in v1");
  });
});
