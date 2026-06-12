// AF_MCP-7.1 — Explicit vitest configuration so the unit suite has a single
// canonical config across local runs and CI.
//
// Hard requirements from plan §9.1 enforced here:
//   - Unit suite is fast (no network) → low timeouts catch accidental I/O.
//   - Integration suites (test/integration/**) are excluded from `npx vitest run`.
//     They run via vitest.integration.config.ts. §9.3 manual HITL is operator-run, not vitest.
//   - Tests run from `mcp/typescript/` so the `.js` import suffixes work.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: [
      "node_modules/**",
      "dist/**",
      "test/integration/**",
      "test/agent-sim/**",
    ],
    environment: "node",
    testTimeout: 5000,
    hookTimeout: 5000,
    reporters: ["default"],
  },
});
