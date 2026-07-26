import { defineConfig } from "vitest/config";

// Pure-module unit tests for the deepened sharer modules (ADR-0003 / ADR-0004).
// Node environment — the policy modules have no DOM. Set `environment: "jsdom"`
// per-test (via a `// @vitest-environment` docblock) if a future test needs it.
export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
