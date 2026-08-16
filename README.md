# better-spend-limits

A self-hosted UI for the [Claude Spend Limits API](https://platform.claude.com/docs/en/manage-claude/spend-limits-api)
and [Analytics API](https://platform.claude.com/docs/en/manage-claude/analytics-api), built to be **cloned and adapted**, not installed.

The raw API gives you one lever: an admin key that can set any member's limit. It has no concept of *who should be allowed to raise whose budget*. This app adds that layer — it joins API members to your reporting hierarchy, so a director only sees and edits their own org, an AI lead sees only the people delegated to them, and every change is audited.

It ships with real assumptions baked in (CSV roster imports, an SSO proxy in front, SQLite for storage). Each is isolated to one file — see [Adapting it](#adapting-it-to-your-organization). Fork it and change what doesn't fit; MIT license, no upstream service to track.

**Live demo:** <https://better-spend-limits-production.up.railway.app> — running against a synthetic 250-person org, no login required. Pick a persona from the sidebar switcher.

## Features

- **Users list & detail** — scoped to what you're allowed to see, with effective limit, its source (override / RBAC group / seat tier / org default), and period-to-date spend.
- **Edit flows** — set or clear a per-user override, with a warning if an increase request is already open.
- **Increase-request queue** — approve at an amount, or deny.
- **Analytics** — MTD spend, spend over time, near-limit report, week-over-week movers, top spenders, all scoped the same way.
- **Admin area** — permission config, AI-lead delegation, HRIS CSV import, audit log, unmatched-members report.
- **Full mock API** — a synthetic 250-person org to develop and test against, no real key needed.

## Stack

Next.js (App Router) + React, Tailwind, Recharts, Drizzle + `better-sqlite3`, Zod, Hono (mock API), Vitest + Playwright. Node 20.11+. ~11.6k lines of TypeScript, ~7k lines of tests.

| | |
|---|---|
| **State** | One SQLite file (`DATABASE_PATH`). Backup = `cp`. |
| **Replicas** | Run one. Horizontal scale means [moving off SQLite](#storage). |
| **Auth** | None of its own — reads a header your SSO proxy sets. |
| **Load** | Read-mostly, internal, sized for hundreds of users. |
| **Failure mode** | API outage → stale numbers with an age shown, not a 500. |

No scheduler, notifications, custom approval workflow, SCIM, or multi-tenancy. Add what you need directly — there's no plugin system to fit it through.

## Architecture

```
    ┌─────────┐
    │ browser │
    └────┬────┘
         │  your SSO proxy sets x-forwarded-email   (AUTH_MODE=proxy)
         ▼
┌───────────────────────────────────────────────────────────────────┐
│ apps/web — Next.js App Router. API keys live here, server-side.   │
│                                                                   │
│   Server Components ──── read ────▶ SQLite  (DATABASE_PATH)       │
│                                      · employees + manager chains │
│   BFF route handlers                 · app config, audit log      │
│     /api/members/[id]/limit          · synced API snapshots       │
│     /api/requests/[id]                          ▲                 │
│     /api/sync                                   │ sync engine     │
└──────────┬──────────────────────────────────────┴─────────────────┘
           │ writes pass through, live         reads are paged in
           ▼                                   and cached locally
┌───────────────────────────────────────────────────────────────────┐
│ ANTHROPIC_BASE_URL                                                │
│   production → https://api.anthropic.com                          │
│   demo       → apps/mock-api on :8787, a synthetic 250-person org  │
│                                                                   │
│   GET/POST/DELETE /v1/organizations/spend_limits/…    Admin key    │
│   GET             /v1/organizations/analytics/…   Analytics key    │
└───────────────────────────────────────────────────────────────────┘
```

Writes (set/clear a limit, approve/deny) are live pass-through calls to the API. Reads come from a local SQLite snapshot that a sync engine pages in — the API caps at 60 requests/min per org, and a members list that fanned out per row would blow that budget on one page. A snapshot older than `sync_stale_after_minutes` (default 15) refreshes on next render; the sidebar shows staleness with a manual Refresh button.

## Quickstart

Requires Node 20.11+. No database server, no API key.

```bash
git clone https://github.com/bwhite8/better-spend-limits.git
cd better-spend-limits
npm install
npm run db:migrate     # create the SQLite schema
npm run db:seed        # load the 250-person synthetic roster
npm run dev            # mock API on :8787, web app on :3000
```

Open <http://localhost:3000> and pick a persona from the sidebar switcher:

| Persona | Email | Sees |
|---|---|---|
| Sana Farah | `sana.farah@example.com` | admin — all 250 members, admin area |
| Anders Mancini | `anders.mancini@example.com` | director — their own subtree |
| Tariq Lindqvist | `tariq.lindqvist@example.com` | AI lead — people delegated to them |
| Sofia Abara | `sofia.abara@example.com` | IC — themselves only |

The app makes real HTTP calls to `apps/mock-api`, which implements all eight spend-limits endpoints plus the cost report. Restarting `npm run dev` resets limits (mock's in-memory); employees/config/audit log persist in SQLite.

## Permission model

Two facts drive everything: the API knows *members*, your HRIS knows *reporting lines*. The `employees` table joins them on email, with a denormalized manager chain (`direct_manager_id` → `tier4_manager_id`) plus `aligned_ai_lead_id`.

**Who can edit a member's limit:** anyone whose id appears in one of the target's configured role columns, plus any admin. Configurable via `edit_roles` in the admin area, default:

```
["tier3_manager", "tier4_manager"]
```

So by default a direct manager can't change a report's budget, but their director and VP can. `edit_roles: []` means admins only.

**AI leads are delegated, not inherited.** `aligned_ai_lead_id` isn't a grantable role by itself — an admin assigns each lead to one or more tier-2/3/4 leaders, and the lead inherits exactly those leaders' edit rights (one hop, never the leaders themselves, never an admin).

**Who can see a member:** exactly who you can edit, plus yourself. Admins see everyone. No read-only-but-visible tier — an out-of-scope member's row and detail page are both absent (403).

**Increase requests** follow the same edit rule. **Every write is audited** — actor, target, old/new values, upstream `request_id`, including failed API calls.

## Adapting it to your organization

| Seam | File |
|---|---|
| Auth | [`apps/web/src/lib/identity.ts`](apps/web/src/lib/identity.ts) — `resolveCurrentEmail()` is the entire auth surface. `AUTH_MODE=proxy` + `AUTH_HEADER` needs no code change. |
| Roster source | [`apps/web/src/db/schema.ts`](apps/web/src/db/schema.ts) — `employees` table is the contract; CSV is just one producer. Keep the validation in `import-employees.ts` if you replace it. |
| Permission rule | [`apps/web/src/db/config-defaults.ts`](apps/web/src/db/config-defaults.ts) for new role columns (config only); [`apps/web/src/lib/permissions.ts`](apps/web/src/lib/permissions.ts) (`canEdit`, `visibleEmployees`) for a differently-shaped rule. |
| Storage | <a id="storage"></a>Drizzle schema + migrations in `apps/web/drizzle`. Moving to Postgres touches [`apps/web/src/db/client.ts`](apps/web/src/db/client.ts), the schema's boolean columns, and two `PRAGMA defer_foreign_keys` calls (→ `DEFERRABLE INITIALLY DEFERRED`). |
| Sync cadence | `sync_stale_after_minutes` (default 15). `MOCK_RATE_LIMIT` lets you rehearse the real 60/min cap locally. |
| Branding | [`apps/web/src/app/layout.tsx`](apps/web/src/app/layout.tsx) for metadata, `apps/web/src/components/nav.tsx` for nav. Plain Tailwind, no theme system. |

## Production deployment

**1. Auth** — set `AUTH_MODE=proxy`, put the app behind your SSO proxy, and make sure it injects a verified email into `AUTH_HEADER`.
> `AUTH_MODE=proxy` trusts that header completely — anything that reaches the app directly can spoof it and become an admin. Bind to a private network and ensure the proxy strips any inbound copy of the header.

`AUTH_MODE=dev` has no authentication at all (used by the demo). Never run it with a real Admin key behind it. `DEV_DEFAULT_EMAIL` is rejected under `AUTH_MODE=proxy` — setting both throws at startup.

**2. Credentials** — `ANTHROPIC_ADMIN_KEY` and `ANTHROPIC_ANALYTICS_KEY` from your secret store. The Admin key can set any member's limit org-wide. Leave `ANTHROPIC_BASE_URL` unset (defaults to the real API) unless you route through a proxy — verify with `npm run verify:api`, which prints the base URL it actually resolved.

**3. Employee roster** — upload a CSV in the admin area with this header:

```
employee_id,name,email,direct_manager_id,tier2_manager_id,tier3_manager_id,tier4_manager_id,aligned_ai_lead_id,is_admin
```

Import is a validated, transactional full replace: references must resolve within the file, emails must be unique, and a roster with no admin is refused. `claude_user_id`/`created_at` are preserved across re-imports by email match. Members the API reports but the roster doesn't contain show up under **Unmatched users** (admin-only) until someone adds them.

**4. Persistence** — one SQLite file at `DATABASE_PATH`. Back it up; mount `/data` on durable storage. Run `npm run db:migrate` on every deploy (the Docker image does this automatically).

## Docker

```bash
docker compose up --build      # → http://localhost:3000
docker compose down -v         # -v also drops the SQLite volume
```

This is the demo profile — no credentials, talks to the mock over the compose network. For production see [above](#production-deployment) and `docker-compose.prod.yml`, which has no mock service at all.

The [hosted sandbox](https://better-spend-limits-production.up.railway.app) is this same demo profile on Railway — `Dockerfile.web` + `Dockerfile.mock`, plus a tiny `Dockerfile.reset` cron that restores the synthetic org on a schedule — with no real Anthropic key anywhere. `AUTH_MODE=dev` there is fine only because everything behind it is fixture data and anyone's edits are wiped on the next reset; don't use it as a deployment template. It has no auth of its own, so the public build also caps imports, rate-limits writes, and bounds the audit log — see the hardening in `apps/web/src/lib/rate-limit.ts` and `import-employees.ts`.

## Security posture

- **Secrets** — two API keys, env-only, server-side. Never logged, stored, or sent to the browser.
- **Egress** — one destination, `ANTHROPIC_BASE_URL`, through one client module. No telemetry.
- **Data at rest** — one SQLite file: names, emails, reporting lines, spend figures, audit log.
- **Auth** — delegated to your proxy in `proxy` mode; no session of its own. Unrecognized `AUTH_MODE` throws at startup.
- **Authorization** — enforced server-side in `permissions.ts` on every render and route, not in the client.
- **Audit** — every write (success or failure) logged with actor, target, old/new values, request id.
- **Blast radius** — the Admin key can change any limit in the org. Anyone who can spoof the proxy header is an admin of this app.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | mock API on :8787 + web app on :3000 |
| `npm test` | unit/integration tests, all workspaces (Vitest) |
| `npm run test:e2e` | Playwright suite; builds and starts both servers |
| `npm run lint` | ESLint across the repo |
| `npm run typecheck` | `tsc -b` over every workspace |
| `npm run db:migrate` | apply migrations to the SQLite file |
| `npm run db:seed` | load synthetic roster + default config |
| `npm run verify:api` | check the **real** API against our schemas (read-only) |

Run `npx playwright install` once before `npm run test:e2e`.

## Environment variables

> **⚠️ An exported `ANTHROPIC_BASE_URL` overrides the checked-in dev config.** Next.js gives real env vars precedence over `.env` files — if your shell exports `ANTHROPIC_BASE_URL`, `npm run dev` silently points at the real API instead of the local mock. Reads then 401; writes would land on a **real organization**.
>
> ```bash
> echo "${ANTHROPIC_BASE_URL:-<unset>}"
> ```
>
> If it's not `<unset>` or localhost, `unset ANTHROPIC_BASE_URL` or override per-run: `ANTHROPIC_BASE_URL=http://localhost:8787 npm run dev`. Playwright and `docker compose` are unaffected — both pass all three API vars explicitly.

### `apps/web`

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | API root. `http://localhost:8787` for the mock. |
| `ANTHROPIC_ADMIN_KEY` | — | Admin key (`read:spend_limits` + `write:spend_limits`). |
| `ANTHROPIC_ANALYTICS_KEY` | — | Analytics key (`read:analytics`), separate from the Admin key. |
| `AUTH_MODE` | `dev` | `dev` = impersonation cookie/switcher, no auth. `proxy` = trust `AUTH_HEADER`. Unrecognized value = startup error. |
| `AUTH_HEADER` | `x-forwarded-email` | Header carrying the authenticated email in proxy mode. |
| `DEV_DEFAULT_EMAIL` | — | Dev mode only: who a cookie-less visitor becomes. Errors if set with `AUTH_MODE=proxy`. |
| `DATABASE_PATH` | `./data/app.db` | SQLite file, relative to `apps/web`. |

### `apps/mock-api`

Synthetic data only — never pair with a real Admin key.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Port the mock listens on. |
| `MOCK_ADMIN_KEY` | `mock-admin-key` | Key the spend-limits surface accepts. |
| `MOCK_ANALYTICS_KEY` | `mock-analytics-key` | Key the analytics surface accepts. |
| `MOCK_SEED` | `42` | Synthetic org seed (test fixtures assume 42). |
| `MOCK_RATE_LIMIT` | `off` | Requests/min, to rehearse the real 60/min limit. |

`.env.example` at the repo root has the full list. `apps/web/.env.development` is checked in and already points at the mock — a fresh clone needs no configuration.

## Mock fidelity

`apps/mock-api` implements the documented contract closely: effective-limit resolution precedence, upsert on (scope, period), bound cursors, approve/deny state transitions, the 60/min rate limit, and the provisional-data watermark. Integration tests run against it over real HTTP.

Known gaps: only `monthly`/`USD` periods and `bucket_width=1d`; RBAC-group fields are inferred rather than documented; no deleted-member fixtures.

**`npm run verify:api`** checks the real API against the same schemas — run it against your org before trusting a fork in production:

```bash
ANTHROPIC_ADMIN_KEY=… ANTHROPIC_ANALYTICS_KEY=… npm run verify:api
```

It issues three read-only GETs (effective limits, increase requests, a 7-day cost report) and cannot mutate anything — the client it uses throws on any non-GET call. Refuses to run against a localhost base URL unless you pass `--force`; use `npm run verify:api -- --dry-run` to target the mock in CI. A row that fails schema validation fails the run with a non-zero exit code.

## Repo layout

```
apps/web           Next.js UI and BFF routes; holds the API keys server-side
apps/mock-api      Hono server emulating api.anthropic.com
packages/shared    Zod wire schemas, decimal money utilities, cursor helpers
packages/seed      Deterministic synthetic-org generator
```

Conventions:

- **Money is never a float.** Decimal strings in minor units (`"41280.125"`), all arithmetic via `packages/shared/src/money.ts`. `null` = unlimited, `"0"` = real zero cap.
- **Enums and objects are open/loose** — unknown values pass through instead of failing a sync.
- **`packages/*` ship TypeScript source, no build step**, extensionless relative imports.

## Development

```bash
npm test              # Vitest, all workspaces
npm run test:e2e      # Playwright; builds the app, starts both servers
npm run lint
npm run typecheck
```

E2e uses its own SQLite file (`apps/web/data/e2e.db`), wiped and re-seeded per run. Specs run in path order; some mutate the roster and restore it in `afterAll` (see `e2e/admin.spec.ts`).

`permissions.test.ts`, `import-employees.test.ts`, and `money.test.ts` document the intended behavior of the parts you're most likely to change — start there.

## License

MIT — see [LICENSE](./LICENSE). Fork it, rename it, run it internally.

Not an official Anthropic product. "Claude" and "Anthropic" are trademarks of Anthropic PBC, used here only to describe what this tool talks to.
