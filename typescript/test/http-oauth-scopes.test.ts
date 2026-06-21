// AG-07 — OAuth scope model unit tests.
//
// PINS the tool→scope mapping to the hosted-mcp.md scope table so a future
// safety reclassification cannot silently re-grant a tool. The mapping is
// derived from the tool safety class (safe→read, write*→write, destructive→
// destroy); this file asserts the exact membership the spec promises and that
// the destroy trio is identical to the API internal path's destructive gate
// (api/app/internal/auth.py `_destructive_endpoints`).

import { describe, it, expect, beforeAll } from "vitest";
import {
  SCOPE_READ,
  SCOPE_WRITE,
  SCOPE_DESTROY,
  requiredScopeForTool,
  parseGrantedScopes,
  expandScopes,
  isToolGranted,
  hasResourceAccess,
} from "../src/safety/scopes.js";
import {
  getFilteredTools,
  clearRegistry,
} from "../src/safety/registry.js";
import { registerAllTools } from "../src/tools/index.js";

// The spec scope table (hosted-mcp.md §Scopes), expressed as tool→scope.
const READ_TOOLS = [
  "whoami",
  "list_artifacts",
  "get_artifact",
  "get_artifact_download_url",
  "list_sessions",
];
const WRITE_TOOLS = ["store_artifact", "request_upload_url", "complete_upload"];
const DESTROY_TOOLS = ["create_download_link", "delete_artifact", "seal_session"];

function allRegisteredToolNames(): string[] {
  // A compliant client with --allow-destructive sees every registered tool.
  return getFilteredTools({
    hasConfirmations: true,
    allowDestructive: true,
    writeConfirmRequired: false,
  }).map((t) => t.name);
}

beforeAll(() => {
  clearRegistry();
  registerAllTools();
});

describe("AG-07 tool→scope mapping (pinned to the spec scope table)", () => {
  it("maps the 5 read tools to artifacts:read", () => {
    for (const name of READ_TOOLS) {
      expect(requiredScopeForTool(name), name).toBe(SCOPE_READ);
    }
  });

  it("maps the 3 write tools to artifacts:write", () => {
    for (const name of WRITE_TOOLS) {
      expect(requiredScopeForTool(name), name).toBe(SCOPE_WRITE);
    }
  });

  it("maps the 3 destroy tools to artifacts:destroy", () => {
    for (const name of DESTROY_TOOLS) {
      expect(requiredScopeForTool(name), name).toBe(SCOPE_DESTROY);
    }
  });

  it("covers exactly the 11 registered tools, with no ungated extras", () => {
    const registered = new Set(allRegisteredToolNames());
    const mapped = new Set([...READ_TOOLS, ...WRITE_TOOLS, ...DESTROY_TOOLS]);
    expect(registered).toEqual(mapped);
    expect(registered.size).toBe(11);
  });

  it("destroy trio matches the API internal path's destructive gate", () => {
    // Must stay identical to api/app/internal/auth.py `_destructive_endpoints`:
    // {create_download_link, delete_artifact, seal_session}. The two enforcement
    // points (MCP scope gate + internal API scope gate) must agree.
    const destroyScoped = allRegisteredToolNames().filter(
      (n) => requiredScopeForTool(n) === SCOPE_DESTROY
    );
    expect(new Set(destroyScoped)).toEqual(new Set(DESTROY_TOOLS));
  });

  it("returns undefined for an unknown tool", () => {
    expect(requiredScopeForTool("not_a_tool")).toBeUndefined();
  });
});

describe("AG-07 scope hierarchy expansion", () => {
  it("read grants only read", () => {
    expect([...expandScopes([SCOPE_READ])].sort()).toEqual([SCOPE_READ]);
  });

  it("write implies read", () => {
    expect([...expandScopes([SCOPE_WRITE])].sort()).toEqual(
      [SCOPE_READ, SCOPE_WRITE].sort()
    );
  });

  it("destroy implies write and read", () => {
    expect([...expandScopes([SCOPE_DESTROY])].sort()).toEqual(
      [SCOPE_DESTROY, SCOPE_READ, SCOPE_WRITE].sort()
    );
  });

  it("an empty grant expands to nothing", () => {
    expect([...expandScopes([])]).toEqual([]);
  });

  it("drops unknown scopes", () => {
    expect([...expandScopes(["openid", "profile", SCOPE_READ])].sort()).toEqual([
      SCOPE_READ,
    ]);
  });
});

describe("AG-07 isToolGranted under expanded scopes", () => {
  it("a read token grants exactly the 5 read tools", () => {
    const gate = expandScopes([SCOPE_READ]);
    expect(READ_TOOLS.every((n) => isToolGranted(n, gate))).toBe(true);
    expect([...WRITE_TOOLS, ...DESTROY_TOOLS].some((n) => isToolGranted(n, gate))).toBe(
      false
    );
  });

  it("a read+write token grants 8 tools and no destroy tools", () => {
    const gate = expandScopes([SCOPE_READ, SCOPE_WRITE]);
    const granted = allRegisteredToolNames().filter((n) => isToolGranted(n, gate));
    expect(new Set(granted)).toEqual(new Set([...READ_TOOLS, ...WRITE_TOOLS]));
    expect(granted).toHaveLength(8);
  });

  it("a destroy token grants all 11 tools", () => {
    const gate = expandScopes([SCOPE_DESTROY]); // implies write+read
    const granted = allRegisteredToolNames().filter((n) => isToolGranted(n, gate));
    expect(granted).toHaveLength(11);
  });

  it("an empty grant grants nothing and denies resources", () => {
    const gate = expandScopes([]);
    expect(allRegisteredToolNames().some((n) => isToolGranted(n, gate))).toBe(false);
    expect(hasResourceAccess(gate)).toBe(false);
  });
});

describe("AG-07 parseGrantedScopes (defensive claim parsing)", () => {
  it("parses a space-separated scope string", () => {
    expect(parseGrantedScopes("artifacts:read artifacts:write")).toEqual([
      SCOPE_READ,
      SCOPE_WRITE,
    ]);
  });

  it("parses an array claim", () => {
    expect(parseGrantedScopes([SCOPE_DESTROY, SCOPE_READ])).toEqual([
      SCOPE_READ,
      SCOPE_DESTROY,
    ]);
  });

  it("drops OIDC/unknown scopes", () => {
    expect(
      parseGrantedScopes("openid profile email artifacts:read")
    ).toEqual([SCOPE_READ]);
  });

  it("treats a missing or garbage claim as an empty grant", () => {
    expect(parseGrantedScopes(undefined)).toEqual([]);
    expect(parseGrantedScopes(null)).toEqual([]);
    expect(parseGrantedScopes(42)).toEqual([]);
    expect(parseGrantedScopes("")).toEqual([]);
  });

  it("de-duplicates and orders by privilege", () => {
    expect(
      parseGrantedScopes("artifacts:write artifacts:read artifacts:write")
    ).toEqual([SCOPE_READ, SCOPE_WRITE]);
  });
});

describe("AG-07 hasResourceAccess", () => {
  it("read scope grants resources", () => {
    expect(hasResourceAccess(expandScopes([SCOPE_READ]))).toBe(true);
    expect(hasResourceAccess(expandScopes([SCOPE_WRITE]))).toBe(true); // implies read
  });
  it("an empty grant denies resources", () => {
    expect(hasResourceAccess(expandScopes([]))).toBe(false);
  });
});
