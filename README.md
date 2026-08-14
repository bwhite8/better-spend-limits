# better-spend-limits

A self-hosted UI for the [Claude Spend Limits API](https://platform.claude.com/docs/en/manage-claude/spend-limits-api)
and the [Analytics cost endpoint](https://platform.claude.com/docs/en/manage-claude/analytics-api).

The APIs give an organisation exactly one lever — an admin key that can set any
member's limit — and no answer to the question every enterprise actually has:
*who is allowed to raise whose budget?* This app supplies that answer. It joins
the API's members to your employee hierarchy, so a director sees and edits their
own org and nobody else's, an AI lead sees the people aligned to them, and every
change lands in an audit log with a name attached.

Clone it, point it at your organisation, run it internally. It is a thin wrapper
by design: the API stays the source of truth and every write goes straight
through to it.

## What you get

- **Members list and detail**, scoped to what you are allowed to see, showing each
  person's effective limit, where that limit came from (personal override, RBAC
  group, seat tier, org default) and their period-to-date spend.
- **Edit flows** — set a per-user override or remove it and fall back to what the
  member inherits, with a warning when they have an increase request open that a
  direct edit will not resolve.
- **An increase-request queue** filtered to the requests you can act on, with
  approve-at-an-amount and deny.
- **Analytics** — spend over time, a near-limit report, week-over-week movers and
  top spenders, all scoped the same way, with the provisional tail of recent
  data visually marked rather than presented as final.
- **An admin area** — permission config, HRIS roster import by CSV, the audit log,
  and the list of API members who match nobody on your roster.
- **A high-fidelity mock of the whole API surface**, so you can evaluate the thing
  end to end against a 250-person synthetic organisation before it ever sees a
  real key.

## Architecture

```
    ┌─────────┐
    │ browser │
    └────┬────┘
         │  your SSO proxy sets x-forwarded-email   (AUTH_MODE=proxy)
         ▼
┌───────────────────────────────────────────────────────────────────┐
│ apps/web — Next.js App Router. The API keys live here, server-side │
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

**The data model is hybrid, and the split matters.** Writes — setting a limit,
removing an override, approving or denying a request — are live pass-through
calls to the API, followed by a targeted re-read of just that member. Reads come
from a local snapshot that a sync engine pages in, because the API allows 60
requests per minute per organisation across every endpoint and a members list
that fanned out per row would exhaust that budget on one page view.

So: the API is the source of truth, SQLite is a cache plus the enrichment (your
hierarchy, your config, your audit trail) that the API has nowhere to put. A
snapshot older than `sync_stale_after_minutes` (default 15) triggers a refresh
on the next page render, and the sidebar always shows how old the data is with a
manual Refresh button next to it.

## Quickstart

Requires Node 20.11 or newer. Nothing else — no database server, no API key.

```bash
git clone https://github.com/bwhite8/better-spend-limits.git
cd better-spend-limits
npm install
npm run db:migrate     # create the SQLite schema
npm run db:seed        # load the 250-person synthetic roster
npm run dev            # mock API on :8787, web app on :3000
```

Open <http://localhost:3000> and pick a persona from the switcher at the bottom
of the sidebar. The interesting ones in the seed-42 organisation:

| Persona | Email | What you see |
|---|---|---|
| Sana Farah | `sana.farah@example.com` | admin — all 250 members, the admin area, every pending request |
| Anders Mancini | `anders.mancini@example.com` | a director — their own subtree only, with edit rights |
| Tariq Lindqvist | `tariq.lindqvist@example.com` | an AI lead — the people aligned to them |
| Sofia Abara | `sofia.abara@example.com` | an ordinary IC — themselves, and nothing else |

Everything is real except the organisation behind it: the app is making genuine
HTTP calls to `apps/mock-api`, which implements all eight spend-limits endpoints
and the cost report, including cursor binding, upsert semantics, approve/deny
state transitions, rate limiting and the provisional-data watermark.

> The synthetic org lives in the mock's memory, so restarting `npm run dev`
> resets any limits you changed. Employees, config and the audit log live in
> SQLite and survive.

## Running with Docker

The demo profile builds both images and wires them together:

```bash
docker compose up --build      # → http://localhost:3000
docker compose down -v         # -v also drops the SQLite volume
```

No credentials are involved; the app talks to the mock over the compose network.
For a real deployment see [Production deployment](#production-deployment) and
`docker-compose.prod.yml`, which has no mock service at all — a production stack
should have no path by which a misconfigured base URL lands on a fixture.

## Commands

Every command runs from the repo root.

| Command | What it does |
|---|---|
| `npm run dev` | mock API on :8787 and the web app on :3000, together |
| `npm test` | unit and integration tests across all workspaces (Vitest) |
| `npm run test:e2e` | Playwright suite; builds the app and starts both servers itself |
| `npm run lint` | ESLint across the repo |
| `npm run typecheck` | `tsc -b` over every workspace |
| `npm run db:migrate` | apply migrations to the SQLite file |
| `npm run db:seed` | load the synthetic roster and default config |
| `npm run verify:api` | check the **real** API against our schemas (read-only) |

Before `npm run test:e2e` the first time: `npx playwright install` to fetch the
browser.

## Environment variables

> ### ⚠️ An exported `ANTHROPIC_BASE_URL` overrides the checked-in dev config
>
> Next.js gives real environment variables precedence over `.env` files. If your
> shell profile exports `ANTHROPIC_BASE_URL` — common if you also use the Claude
> API for anything else — then `npm run dev` points this app at
> `https://api.anthropic.com` even though `apps/web/.env.development` says
> `http://localhost:8787`, and nothing in the UI announces the switch.
>
> This has happened on this project more than once. Reads fail with 401, which
> looks like a broken demo; but the edit-limit and approve/deny flows are writes,
> and they would land on a **real organisation**.
>
> Check what your shell is actually exporting:
>
> ```bash
> echo "${ANTHROPIC_BASE_URL:-<unset>}"
> ```
>
> If it prints anything other than `<unset>` or a localhost URL, either
> `unset ANTHROPIC_BASE_URL` or override it per-run:
>
> ```bash
> ANTHROPIC_BASE_URL=http://localhost:8787 npm run dev
> ```
>
> The Playwright suite and `docker compose` are immune — both pass all three API
> variables explicitly, which beats the ambient value.

### `apps/web`

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | API root. Point at `http://localhost:8787` for the mock. |
| `ANTHROPIC_ADMIN_KEY` | — | Admin API key, scopes `read:spend_limits` + `write:spend_limits`. Can change limits org-wide. |
| `ANTHROPIC_ANALYTICS_KEY` | — | Analytics API key, scope `read:analytics`. A **separate** key; the API rejects the Admin key here. |
| `AUTH_MODE` | `dev` | `dev` = impersonation cookie and the user switcher (no authentication at all). `proxy` = trust `AUTH_HEADER`. An unrecognised value is a startup error rather than a silent fallback. |
| `AUTH_HEADER` | `x-forwarded-email` | Header carrying the authenticated email in proxy mode. |
| `DATABASE_PATH` | `./data/app.db` | SQLite file. Relative paths resolve against the working directory, which is `apps/web` for every command that opens it. |

### `apps/mock-api`

Local demos only; this service is never deployed.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Port the mock listens on. |
| `MOCK_ADMIN_KEY` | `mock-admin-key` | Key the spend-limits surface accepts. |
| `MOCK_ANALYTICS_KEY` | `mock-analytics-key` | Key the analytics surface accepts. |
| `MOCK_SEED` | `42` | Seed for the synthetic organisation. 42 is what the test fixtures refer to. |
| `MOCK_RATE_LIMIT` | `off` | `off`, or requests per minute. Set a number to rehearse hitting the real 60/min org limit. |

`.env.example` at the repo root carries the same list in copyable form.
`apps/web/.env.development` is checked in and already points at the mock, so a
fresh clone needs no configuration.

## Permission model

Two facts drive everything: the API knows about *members*, and your HRIS knows
about *reporting lines*. The `employees` table holds the join — email is the key,
and each row carries its manager chain denormalised (`direct_manager_id`,
`tier2_manager_id`, `tier3_manager_id`, `tier4_manager_id`) plus an
`aligned_ai_lead_id`, which is how HRIS exports arrive and means the app never
recomputes a chain.

**Who may edit a member's limit.** Anyone whose employee id appears in one of the
target's configured role columns, plus any admin. The set of columns that count
is config, not code — `edit_roles` in the admin area, defaulting to:

```
["tier3_manager", "tier4_manager", "aligned_ai_lead"]
```

So by default a person's own manager cannot change their budget, but their
director, their VP and their aligned AI lead can. Columns that are null (the CEO
has no tier-4 manager) are skipped rather than treated as a match. Setting
`edit_roles` to `[]` is legitimate and means admins only.

**Who may see a member.** You can view exactly the people you can edit, plus
yourself. Admins view everyone. There is no read-only-but-visible tier: if a
member is not yours, their row is absent from the list and their detail page
returns a 403.

**Increase requests** follow the edit rule — a request is visible if and only if
it is actionable by you. A request from someone with no employee record is
visible to admins only, flagged as unmatched.

**Everything that writes, audits.** Setting a limit, removing an override,
approving, denying, changing config and importing a roster each insert an
`audit_log` row with the actor's email, the target, and a JSON detail blob
carrying old and new values and the upstream `request_id` where there was one.
Failed API calls are audited too — an attempted write that got a 429 is exactly
the thing you want a record of.

## Production deployment

### 1. Authentication

Set `AUTH_MODE=proxy` and put the app behind your SSO reverse proxy (oauth2-proxy,
Cloudflare Access, an ALB with OIDC — anything that terminates auth and injects a
verified email header).

> **`AUTH_MODE=proxy` means the app trusts `AUTH_HEADER` completely.** Anything
> that can reach the app's port directly can send `x-forwarded-email:
> ceo@yourcompany.com` and become an admin. Bind it to loopback or a private
> network, ensure the proxy *strips* any inbound copy of that header rather than
> passing it through, and never publish the port.

`AUTH_MODE=dev` has no authentication whatsoever — it exists so a laptop demo can
switch personas. Do not run it anywhere reachable.

### 2. Credentials

Provide `ANTHROPIC_ADMIN_KEY` and `ANTHROPIC_ANALYTICS_KEY` from your secret
store, not from a file on the host. The Admin key can set any member's limit and
approve any increase request in your organisation; scope your handling of it
accordingly.

> **The ambient-variable hazard applies here too, in reverse.** A base URL is the
> one setting that decides which organisation this app mutates, and a real
> environment variable silently beats every config file. Whatever your deployment
> mechanism, confirm the value the *running process* resolved rather than the one
> you think you set — that is what the "Base URL" line printed by
> `npm run verify:api` is for.

Leave `ANTHROPIC_BASE_URL` unset in production unless you genuinely route through
a proxy; the default is already the real API.

### 3. The employee roster

The synthetic seed is for demos. In production the roster comes from your HRIS as
a CSV, uploaded in the admin area, with this exact header:

```
employee_id,name,email,direct_manager_id,tier2_manager_id,tier3_manager_id,tier4_manager_id,aligned_ai_lead_id,is_admin
```

Import is a transactional full replace, validated before anything is written:
manager and AI-lead references must resolve within the file, emails must be
unique, and a roster with no `is_admin=1` row is refused — nothing else could
undo that. `claude_user_id` and `created_at` are preserved for emails present on
both the old and new roster, so a re-import does not force a re-match.

> An admin can upload a roster that does not include themselves, and will lose
> access on the next page load. The audit row still names them: `audit_log` has
> no foreign key to `employees`, so a departed admin's id survives their removal.
> Re-running `npm run db:seed` restores the synthetic roster if you are testing.

Members the API reports but the roster does not contain appear under **Unmatched
members** in the admin area. They are invisible to everyone except admins until
someone adds them, which is the intended failure mode — an unknown member should
not silently become nobody's responsibility.

### 4. Persistence and backup

Everything the app owns lives in one SQLite file at `DATABASE_PATH`: the roster,
the config, the audit log, and the synced snapshots. The snapshots are
disposable — they rebuild from the API on the next sync. The audit log is not.
Back the file up, and mount `/data` on durable storage if you are running the
container.

Run `npm run db:migrate` on deploy. The Docker image does this on every start,
because migrations are idempotent and the volume may be older than the image.

## Mock fidelity, and how to check it

`apps/mock-api` implements the documented contract closely — the resolution
precedence for effective limits, upsert keyed on (scope, period), cursors bound
to the query parameters that issued them, approve-writes-an-override-and-resolves,
idempotent deny, the 60/min rate limit, the `data_refreshed_at` watermark and the
revision of provisional rows. The web app's own integration tests run against it
over real HTTP rather than against stubs.

It is still a mock, built from the same schemas the app parses with. That is a
closed loop: if Anthropic changes the wire shape, the mock keeps agreeing with us
and nothing tells you until production reads start failing.

Known gaps, all sitting on the "we could not observe it" side of the line:

- Only `monthly` periods and `USD`, and only `bucket_width=1d` on the cost report.
- RBAC-group source payloads (`rbac_group_id`, `rbac_group_name`) are inferred
  rather than documented, so they are parsed as optional.
- The mock's provisional-tail behaviour (rows after the watermark are deflated
  and later revised upward) is a plausible model of late-arriving usage, not a
  reproduction of a measured one.
- No deleted members, so the "increase requests exclude ex-members" rule is
  implemented but unexercised.

**`npm run verify:api` closes the loop.** It points the real client at the real
API and checks every returned row against the schemas in `packages/shared`:

```bash
ANTHROPIC_ADMIN_KEY=… ANTHROPIC_ANALYTICS_KEY=… npm run verify:api
```

It issues three GETs — the first page of effective limits, the first page of
increase requests, and a 7-day cost report — and nothing else. The `fetch` it
uses throws on any non-GET request, so it cannot mutate an organisation even if
someone later adds a check that tries to. It refuses to run against a localhost
base URL unless you pass `--force`, because verifying the mock against the
schemas the mock was built from proves nothing; `npm run verify:api -- --dry-run`
targets the mock deliberately, with the mock's own keys, for CI.

Output is a per-endpoint table. Unknown fields and unknown open-enum members
(a new `source.type`, say) are reported but do not fail the run — the schemas are
loose and open on purpose, so those are advance notice. A row that fails to parse
does fail the run, with a non-zero exit code, and means the schemas in
`packages/shared` and the mock need updating together.

## Repo layout

```
apps/web           Next.js UI and BFF routes; holds the API keys server-side
apps/mock-api      Hono server emulating api.anthropic.com
packages/shared    Zod wire schemas, decimal money utilities, cursor helpers
packages/seed      Deterministic synthetic-org generator
```

A few conventions worth knowing before you change anything:

- **Money is never a float.** Amounts are decimal strings in minor units and may
  carry fractional cents (`"41280.125"`). All arithmetic goes through
  `packages/shared/src/money.ts`; `parseFloat` on a stored amount is a bug.
  `null` means unlimited, `"0"` means a real zero cap, and a `"0"`
  period-to-date reading may just mean the reading was unavailable — which is why
  the UI never renders a confident "0% used".
- **Enumerations are open and objects are loose.** An unknown `source.type` or
  request status passes through instead of failing a sync.
- **The packages ship TypeScript source with no build step**, re-exported from
  each `src/index.ts`, and relative imports inside them are extensionless.

## Development

```bash
npm test              # Vitest, all workspaces
npm run test:e2e      # Playwright; builds the app, starts both servers
npm run lint
npm run typecheck
```

The e2e suite uses its own SQLite file (`apps/web/data/e2e.db`), which it wipes
and re-seeds per run, and pins the app to the mock through explicit `webServer`
environment entries. Specs run in path order and some of them deliberately mutate
the world — if you add one that changes the roster, restore it in `afterAll` the
way `e2e/admin.spec.ts` does.

## License

MIT — see [LICENSE](./LICENSE).

Not an official Anthropic product. "Claude" and "Anthropic" are trademarks of
Anthropic PBC, used here only to describe what this tool talks to.
