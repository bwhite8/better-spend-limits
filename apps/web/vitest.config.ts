import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // `tsconfig.json` sets `jsx: "preserve"` because Next owns the transform, and
  // Vite reads that setting — leaving raw JSX in the output, which then fails
  // import analysis. Any test that imports a `.tsx` module needs this override.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    name: "web",
    environment: "node",
    // Playwright specs live in `e2e/` and must never be picked up by Vitest.
    include: ["src/**/*.test.ts"],
    exclude: ["e2e/**", "node_modules/**", ".next/**"],
  },
});
