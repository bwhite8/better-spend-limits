import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "seed",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
