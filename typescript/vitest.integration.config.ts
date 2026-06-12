// AF_MCP-7.2 — Integration suite vitest config.
//
// Why a separate config: `vitest.config.ts` excludes `test/integration/**`
// from the unit suite (the unit suite must stay fast + offline; integration
// runs against staging or local stubs and takes longer). Vitest's exclude
// wins over positional include filters, so `npx vitest run test/integration`
// against the unit config finds zero files. This config inverts the
// include/exclude so the integration directory is the only thing collected.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    environment: "node",
    // Integration tests can take longer (stub server lifecycle, real network
    // when staging is set); raise the timeouts vs. the unit suite.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: ["default"],
  },
});
