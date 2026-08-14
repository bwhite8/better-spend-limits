import { defineConfig } from "vitest/config";

// Vitest 4 removed `vitest.workspace.ts`; multi-package runs are configured with
// `test.projects` here instead. Each workspace keeps its own vitest.config.ts.
export default defineConfig({
  test: {
    projects: ["packages/*/vitest.config.ts", "apps/*/vitest.config.ts"],
    passWithNoTests: true,
  },
});
