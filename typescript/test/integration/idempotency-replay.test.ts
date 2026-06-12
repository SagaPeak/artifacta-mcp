// AF_MCP-7.2.07–08 — Idempotency-key replay subsuite.
//
// Per plan §6.2 + the QA spec: two `store_artifact` calls with the same
// `idempotency_key` must return the same `artifact_id` and `usage_storage_bytes`
// must increase by exactly one artifact's worth (verified by `whoami`
// before/after).
//
// AF_MCP-3.1 (Phase 6a) shipped `store_artifact`, so these cases now dispatch
// the real tool end-to-end against the staging sandbox tenant. They still SKIP
// cleanly when `ARTIFACTA_STAGING_KEY` is unset (graded `[needs-staging]`, not a
// failure). The HTTP layer auto-injects `Idempotency-Key` for `POST /v1/artifacts`
// (`http/client.ts`) and forwards a caller-supplied `idempotency_key` verbatim;
// this file is the integration proof that the dedup contract holds through the
// tool surface.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setHttpClient, resetHttpClient } from "../../src/http/instance.js";
import { ArtifactaHttpClient } from "../../src/http/client.js";
import { registerAllTools } from "../../src/tools/index.js";
import { clearRegistry, getToolRegistration } from "../../src/safety/registry.js";
import { hasStaging, STAGING_KEY, STAGING_API_URL } from "./_setup.js";

const STAGING = hasStaging();

interface TextResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<TextResult> {
  const reg = getToolRegistration(name);
  if (!reg) throw new Error(`tool not registered: ${name}`);
  const result = await reg.handler(args, { requestId: `integration-idem-${name}-${Date.now()}` });
  return result as TextResult;
}

/** Base64 of a small, unique payload so each run stores distinct bytes. */
function uniqueContent(): string {
  return Buffer.from(`replay-fixture-${Date.now()}-${Math.random()}`).toString("base64");
}

beforeAll(() => {
  if (!STAGING) return;
  clearRegistry();
  registerAllTools();
  setHttpClient(new ArtifactaHttpClient({ apiKey: STAGING_KEY, apiUrl: STAGING_API_URL }));
});

afterAll(() => {
  if (!STAGING) return;
  resetHttpClient();
  clearRegistry();
});

describe.skipIf(!STAGING)(
  "AF_MCP-7.2.07 — replay returns same artifact_id [needs-staging]",
  () => {
    it("two store_artifact calls with the same idempotency_key resolve to one artifact_id", async () => {
      const key = `replay-7207-${Date.now()}`;
      const content = uniqueContent();
      const first = await callTool("store_artifact", {
        filename: "replay.txt",
        content,
        content_type: "text/plain",
        idempotency_key: key,
      });
      const second = await callTool("store_artifact", {
        filename: "replay.txt",
        content,
        content_type: "text/plain",
        idempotency_key: key,
      });
      expect(first.isError ?? false).toBe(false);
      expect(second.isError ?? false).toBe(false);
      const a = JSON.parse(first.content[0].text) as { artifact_id: string };
      const b = JSON.parse(second.content[0].text) as { artifact_id: string };
      expect(b.artifact_id).toBe(a.artifact_id);
    });
  }
);

describe.skipIf(!STAGING)(
  "AF_MCP-7.2.08 — usage_storage_bytes incremented exactly once [needs-staging]",
  () => {
    it("whoami before/after shows a single-artifact delta after two replayed calls", async () => {
      // Assumes a quiescent sandbox tenant (the only writer in this describe).
      const key = `replay-7208-${Date.now()}`;
      const content = uniqueContent();

      const before = JSON.parse((await callTool("whoami")).content[0].text) as {
        usage_storage_bytes: number;
      };

      const stored = JSON.parse(
        (
          await callTool("store_artifact", {
            filename: "replay.txt",
            content,
            content_type: "text/plain",
            idempotency_key: key,
          })
        ).content[0].text
      ) as { size_bytes: number };

      await callTool("store_artifact", {
        filename: "replay.txt",
        content,
        content_type: "text/plain",
        idempotency_key: key,
      });

      const after = JSON.parse((await callTool("whoami")).content[0].text) as {
        usage_storage_bytes: number;
      };

      // Replay deduped: usage grew by exactly one artifact's size, not two.
      expect(after.usage_storage_bytes - before.usage_storage_bytes).toBe(stored.size_bytes);
    });
  }
);
