import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `@bsl/*` ship TypeScript source with no build step (see Phase 1), so Next
  // has to compile them itself.
  transpilePackages: ["@bsl/shared", "@bsl/seed"],
  // better-sqlite3 is a native addon; it must be required at runtime, not bundled.
  serverExternalPackages: ["better-sqlite3"],
  // `next dev` otherwise writes its own `AGENTS.md`/`CLAUDE.md` into this
  // workspace on every start. Nothing in the plan asks for them, and silently
  // generated AI-agent instruction files are not something this repo should
  // grow by accident.
  agentRules: false,
};

export default nextConfig;
