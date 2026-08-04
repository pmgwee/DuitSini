import { defineConfig } from "vitest/config";

// Pure-module unit tests for the deepened sharer modules (ADR-0003 / ADR-0004).
// Node environment — the policy modules have no DOM. Set `environment: "jsdom"`
// per-test (via a `// @vitest-environment` docblock) if a future test needs it.
const root = process.cwd().replace(/\\/g, "/");

export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "tests/**/*.test.ts"],
  },
  resolve: {
    alias: [
      // Match tsconfig's `@/*` → `./*`. Regex (not a bare `@`) so it does NOT
      // collide with scoped packages like `@supabase/...`.
      { find: /^@\/(.*)$/, replacement: `${root}/$1` },
      // Next provides `server-only` as a virtual module; stub it for standalone vitest.
      { find: "server-only", replacement: `${root}/tests/__stubs__/server-only.ts` },
    ],
  },
});
