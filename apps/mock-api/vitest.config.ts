import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "mock-api",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
