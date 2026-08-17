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
  // Baseline security headers on every response. Deliberately conservative:
  // the CSP carries ONLY `frame-ancestors`, which has no effect on resource
  // loading, so it can't break Next's inline bootstrap scripts or Recharts the
  // way a `script-src`/`default-src` policy could. This app is never meant to
  // be embedded, and its URLs carry employee ids — hence the anti-framing pair
  // and `no-referrer`. TLS/HSTS is terminated at Railway's edge.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          // Belt-and-suspenders for browsers that predate `frame-ancestors`.
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;
