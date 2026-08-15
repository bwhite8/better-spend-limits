# better-spend-limits

A self-hosted UI for the [Claude Spend Limits API](https://platform.claude.com/docs/en/manage-claude/spend-limits-api)
and the [Analytics cost endpoint](https://platform.claude.com/docs/en/manage-claude/analytics-api),
written to be **cloned and adapted** rather than installed.

The APIs give an organization exactly one lever — an admin key that can set any
member's limit — and no answer to the question every enterprise actually has:
*who is allowed to raise whose budget?* This app supplies that answer. It joins
the API's members to your employee hierarchy, so a director sees and edits their
own org and nobody else's, an AI lead sees the people aligned to them, and every
change lands in an audit log with a name attached.

It runs as-is against a real organization, and it assumes things about you that
will not all be true: that reporting lines arrive as a CSV, that an SSO proxy in
front of the app is acceptable, that one SQLite file is enough state, that
"director, VP or aligned AI lead" is the right rule. Each of those assumptions is
roughly one file deep, and [Adapting it](#adapting-it-to-your-organization) names
the file. Fork it, change what does not fit, keep your changes — the licence is
MIT and there is no upstream service to stay compatible with.

Nothing phones home. The only outbound connection the app makes is to
`ANTHROPIC_BASE_URL`, through a single injectable client
([`apps/web/src/lib/anthropic/client.ts`](apps/web/src/lib/anthropic/client.ts)),
and the API keys never leave the server.

**Look at it first:** <https://better-spend-limits-production.up.railway.app> —
the whole app on Railway against a synthetic 250-person organization rather than
anyone's real one. Pick a persona from the switcher at the bottom of the sidebar;
there is no login, because there is nothing real behind it. See
[The hosted sandbox](#the-hosted-sandbox) for exactly what is running there.

## What you get

- **Users list and detail**, scoped to what you are allowed to see, showing each
  person's effective limit, where that limit came from (personal override, RBAC
  group, seat tier, org default) and their period-to-date spend.
- **Edit flows** — set a per-user override or remove it and fall back to what the
  member inherits, with a warning when they have an increase request open that a
  direct edit will not resolve.
- **An increase-request queue** filtered to the requests you can act on, with
  approve-at-an-amount and deny.
- **Analytics** — month-to-date spend and per-user average, spend over time, a
  near-limit report, week-over-week movers and top spenders, all scoped the same
  way, with the provisional tail of recent data visually marked rather than
  presented as final. The organization-wide figures beside your own are the one
  deliberate exception to that scoping, and `show_org_wide_kpis` turns them off.
- **An admin area** — permission config, AI-lead delegation, HRIS roster import by
  CSV, the audit log, and the list of API members who match nobody on your roster.
- **A high-fidelity mock of the whole API surface**, so you can evaluate the thing
  end to end against a 250-person synthetic organization before it ever sees a
  real key — and so your fork has something to test against in CI.

## What you are taking on

Roughly 11,600 lines of TypeScript, plus 7,000 of tests. The dependency list is
short on purpose: Next.js (App Router) and React for the app, Tailwind and
Recharts for the interface, Drizzle and `better-sqlite3` for storage, Zod for the
wire schemas, Hono for the mock, Vitest and Playwright for tests. No queue, no
cache, no broker, no state manager, no component library. Node 20.11 or newer is
the only runtime requirement.

The operational surface is one container and one file:

| Concern | What to expect |
|---|---|
| **State** | One SQLite file at `DATABASE_PATH` — roster, config, audit log, synced snapshots. Backup is `cp`. |
| **Replicas** | Run one. The sync lock lives in the database, so parallel renders inside a process are safe; two processes on two filesystems would double your API usage and split the audit log. Horizontal scale means [moving off SQLite](#storage--sqlite-and-when-it-stops-being-enough). |
| **Authentication** | None of its own. It reads a header your SSO proxy sets. |
| **Load** | Read-mostly, internal, sized for an organization of hundreds. Page renders hit SQLite, not the API. |
| **Failure mode** | An API outage degrades to stale numbers with the age shown in the sidebar, not to a 500. |

What it deliberately does not have: a scheduler, notifications, an approval
workflow beyond the API's own increase requests, SCIM, or multi-tenancy. If you
need one of those, write it — the codebase is small enough to hold the change,
and there is no plugin interface you have to fit it through.

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
│   sandbox    → the mock-api service on Railway's private network  │
│                                                                   │
│   GET/POST/DELETE /v1/organizations/spend_limits/…    Admin key    │
│   GET             /v1/organizations/analytics/…   Analytics key    │
└───────────────────────────────────────────────────────────────────┘
```

**The data model is hybrid, and the split matters.** Writes — setting a limit,
removing an override, approving or denying a request — are live pass-through
calls to the API, followed by a targeted re-read of just that member. Reads come
from a local snapshot that a sync engine pages in, because the API allows 60
requests per minute per organization across every endpoint and a members list
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
of the sidebar. The interesting ones in the seed-42 organization:

| Persona | Email | What you see |
|---|---|---|
| Sana Farah | `sana.farah@example.com` | admin — all 250 members, the admin area, every pending request |
| Anders Mancini | `anders.mancini@example.com` | a director — their own subtree only, with edit rights |
| Tariq Lindqvist | `tariq.lindqvist@example.com` | an AI lead — the people aligned to them |
| Sofia Abara | `sofia.abara@example.com` | an ordinary IC — themselves, and nothing else |

Everything is real except the organization behind it: the app is making genuine
HTTP calls to `apps/mock-api`, which implements all eight spend-limits endpoints
and the cost report, including cursor binding, upsert semantics, approve/deny
state transitions, rate limiting and the provisional-data watermark.

> The synthetic org lives in the mock's memory, so restarting `npm run dev`
> resets any limits you changed. Employees, config and the audit log live in
> SQLite and survive.

## Permission model

Read this before you change anything: it is the part of the app that is actually
opinionated, and most adaptations are adaptations of it.

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
["tier3_manager", "tier4_manager"]
```

So by default a person's own manager cannot change their budget, but their
director and their VP can. Columns that are null (the CEO has no tier-4 manager)
are skipped rather than treated as a match. Setting `edit_roles` to `[]` is
legitimate and means admins only.

**AI leads are delegated, not inherited.** `aligned_ai_lead_id` is on the roster
because HRIS exports carry it, but it is deliberately *not* a grantable role: it
is assigned across whole subtrees, so a lead's reach had nothing to do with their
own place in the hierarchy — on the synthetic org, the eight leads would have
seen 87, 69, 27, 26, 25, 25, 24 and 11 people. Instead an admin assigns each lead
to one or more tier-2/3/4 leaders in the admin area, and the lead exercises
exactly those leaders' hierarchy roles. Three rules hold:

- **The leaders' people, never the leaders.** A lead cannot see or edit the
  person they were assigned to, only who that person's roles reach.
- **Never an admin.** Assigning a lead to an administrator is refused, in the
  form and in the server action: an admin's scope is the whole organization, so
  it would be a grant of admin rights under another name.
- **One hop.** A leader's own delegations never chain onward.

The rule is one set: `canEdit` compares the target's role columns against
`[actor.id, ...leaders delegated to the actor]` rather than against the actor's
id alone. Every assignment is an `audit_log` row.

**Who may see a member.** You can view exactly the people you can edit, plus
yourself. Admins view everyone. There is no read-only-but-visible tier: if a
member is not yours, their row is absent from the list and their detail page
returns a 403.

**Increase requests** follow the edit rule — a request is visible if and only if
it is actionable by you. A request from someone with no employee record is
visible to admins only, flagged as unmatched.

**Everything that writes, audits.** Setting a limit, removing an override,
approving, denying, changing config, delegating an AI lead and importing a roster
each insert an `audit_log` row with the actor's email, the target, and a JSON detail blob
carrying old and new values and the upstream `request_id` where there was one.
Failed API calls are audited too — an attempted write that got a 429 is exactly
the thing you want a record of.

## Adapting it to your organization

Six seams, in rough order of how likely you are to need them. Each is a named
place in the code rather than a setting in a configuration language — this is a
codebase you edit, and these are the spots where editing is cheap.

### Identity — replacing the auth

[`apps/web/src/lib/identity.ts`](apps/web/src/lib/identity.ts). Everything
downstream of `resolveCurrentEmail()` takes an `Employee` row, so that one
function is the entire authentication surface: it returns the email the request
claims to be, from a trusted header in `proxy` mode or from the dev switcher's
cookie. No match on the roster means no access, with no fallback identity — a
mistyped header renders the "not provisioned" 403 rather than silently resolving
to somebody.

If your SSO terminates at a proxy, you need no code change at all — set
`AUTH_MODE=proxy` and `AUTH_HEADER`. If you want the app to do OIDC itself, or to
read a signed assertion instead of a plain header, replace `resolveCurrentEmail`
and leave the rest of the app alone. `AUTH_MODES` is a closed union, so adding a
third mode is a type error at every site that has to handle it — which is the
intent.

### The roster — replacing the CSV

The `employees` table is the contract
([`apps/web/src/db/schema.ts`](apps/web/src/db/schema.ts)); the CSV import is
merely one producer of it. A nightly job that upserts the same columns from
Workday, BambooHR or AD is a legitimate substitute and touches nothing else in
the app.

Two things to carry over rather than reinvent. First, the validation in
[`apps/web/src/lib/import-employees.ts`](apps/web/src/lib/import-employees.ts):
manager and AI-lead references must resolve *within the roster*, emails must be
unique, and a roster with no admin is refused — the checks matter more, not less,
when the roster arrives unattended. Second, the preservation rule: `claude_user_id`
and `created_at` survive for emails present on both the old and new roster, so a
re-import does not force every member to be re-matched against the API.

Column names in TypeScript are identical to the SQL column names throughout
(`tier3_manager_id`, not `tier3ManagerId`) — deliberately, because it lets a
configured role name become a column reference by string concatenation. Keep that
if you extend the table.

### The permission rule — config first, then code

Start with config. `edit_roles` is editable in the admin area, and its legal
values are `EDIT_ROLE_VALUES` in
[`apps/web/src/db/config-defaults.ts`](apps/web/src/db/config-defaults.ts), each
mapping to an `employees.<role>_id` column.

A **new relationship** — a dotted-line lead, a cost-centre owner, a delegate —
is a migration adding one column, one entry in `EDIT_ROLE_VALUES`, and nothing
else: the permission engine resolves it by name.

A **person-by-person grant** rather than a column has a worked example already:
AI-lead delegation is a join table (`ai_lead_assignments`), an authority set
resolved once per request by `authorityIdsOf`, and an admin form. Copy that shape
rather than adding a second `canEdit` — it stays one comparison, and it stays out
of the per-request loops.

A **differently-shaped rule** — one that is not "the actor's id appears in a
column on the target's row", such as membership in a cost centre or a grant over
a whole department — means editing `canEdit` and `visibleEmployees` in
[`apps/web/src/lib/permissions.ts`](apps/web/src/lib/permissions.ts). Every page
and route funnels through those two functions plus `canActOnRequest`, so the
blast radius is small and the tests in `permissions.test.ts` will tell you
immediately if you have widened visibility by accident. Widen them carefully: the
API has no per-member authorisation of its own, so this file *is* the access
control.

### Storage — SQLite, and when it stops being enough

Drizzle, one schema file, one migration directory (`apps/web/drizzle`). The
snapshot tables are disposable; `employees`, `app_config`, `ai_lead_assignments`
and `audit_log` are not.

SQLite is the right default for a single-instance internal tool and the wrong
default if you need multiple replicas, an existing backup regime, or the audit
log queryable from your warehouse. Moving to Postgres is a day of work rather
than a rewrite, because the queries are Drizzle rather than hand-written SQL and
`better-sqlite3` is imported in exactly one place. What you would touch: the
dialect and the client in
[`apps/web/src/db/client.ts`](apps/web/src/db/client.ts), the `integer`-boolean
columns in the schema, a regenerated migration, and the two
`PRAGMA defer_foreign_keys` calls that let the roster replace itself inside one
transaction (`db/seed.ts` and `lib/employee-roster.ts`); Postgres checks those
self-referencing keys per statement instead, so the equivalent is
`DEFERRABLE INITIALLY DEFERRED` on the manager columns.

### Cadence, and the rate-limit budget you are spending

`sync_stale_after_minutes` (default 15) is the whole cadence story: a page render
that finds the snapshot older than that refreshes it first. The number is a
trade between staleness and the API's 60 requests per minute per organization —
which is an organization-wide budget, so anything else you run against the same
org is spending from it too. Set `MOCK_RATE_LIMIT` to a number in local runs to
rehearse what hitting it looks like before you find out in production.

### Naming and chrome

Page metadata lives in
[`apps/web/src/app/layout.tsx`](apps/web/src/app/layout.tsx), navigation in
`apps/web/src/components/nav.tsx`. There is no theme system and no logo slot —
it is Tailwind in the components, so rebranding is a search and replace rather
than a configuration exercise.

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

`AUTH_MODE=dev` has no authentication whatsoever — it exists so a demo can switch
personas. The hosted sandbox runs it on a public URL and that is fine there,
because the only organization it can damage is a fixture regenerated on the next
redeploy. Reachability is not the test: what matters is whether a real Admin key
is behind the app. If one is, `AUTH_MODE=dev` means the first person to guess the
URL can raise their own budget.

**`DEV_DEFAULT_EMAIL` is rejected under `AUTH_MODE=proxy`.** In dev mode it names
the employee a cookie-less visitor becomes, which is how the demo opens on a
populated page. In proxy mode the same variable would hand an identity to a
request whose SSO header went missing — a proxy misconfiguration silently
becoming a logged-in session. Setting both throws at startup, with a message
naming both variables, rather than resolving to one of them.

### 2. Credentials

Provide `ANTHROPIC_ADMIN_KEY` and `ANTHROPIC_ANALYTICS_KEY` from your secret
store, not from a file on the host. The Admin key can set any member's limit and
approve any increase request in your organization; scope your handling of it
accordingly.

> **The ambient-variable hazard applies here too, in reverse.** A base URL is the
> one setting that decides which organization this app mutates, and a real
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
both the old and new roster, so a re-import does not force a re-match. AI-lead
delegations naming somebody the new file does not contain are dropped in the same
transaction, and the count is reported back — a delegation is a permission, so
losing one is told, not discovered.

> An admin can upload a roster that does not include themselves, and will lose
> access on the next page load. The audit row still names them: `audit_log` has
> no foreign key to `employees`, so a departed admin's id survives their removal.
> Re-running `npm run db:seed` restores the synthetic roster if you are testing.

Members the API reports but the roster does not contain appear under **Unmatched
users** in the admin area. They are invisible to everyone except admins until
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

### The hosted sandbox

<https://better-spend-limits-production.up.railway.app> is that same demo profile
on Railway. **Both** images are deployed, as two services — `Dockerfile.web` for
the app, `Dockerfile.mock` for the synthetic organization — with the web
service's `ANTHROPIC_BASE_URL` pointed at the mock over Railway's private
network. The same two containers `docker compose up` gives you, hosted rather
than local. No Anthropic key exists anywhere in it; the only credentials are the
mock's own `mock-admin-key` and `mock-analytics-key`.

The sandbox runs `AUTH_MODE=dev`, so it has no authentication and anyone with the
link can switch to the admin persona and change limits. That is acceptable only
because everything behind it is fixture data. Treat it as a demo of the UI and
not as a deployment template — for a deployment with a real Admin key in it,
[Production deployment](#production-deployment) applies instead and none of this
does.

Standing up your own evaluation instance is useful for a security review or a
demo to the people who will use it. Deploy this repo twice in one project:

| Service | Dockerfile | Settings |
|---|---|---|
| `mock-api` | `Dockerfile.mock` | `MOCK_SEED=42`, `MOCK_ADMIN_KEY`, `MOCK_ANALYTICS_KEY`. Needs no public domain — the web service reaches it internally. |
| `web` | `Dockerfile.web` | `ANTHROPIC_BASE_URL` = the mock's internal address, the two matching mock keys, `AUTH_MODE=dev`, `DATABASE_PATH=/data/app.db`, and a volume mounted at `/data`. |

The web image's default command only migrates, so give that service a start
command that seeds as well — `npm run db:migrate && npm run db:seed && npm run
start -w apps/web`, the same override `docker-compose.yml` uses. Without the seed
the roster is empty and every persona 403s.

Two things reset on redeploy and two do not: the mock's limits and requests live
in its memory and come back as seed 42 generated them, and the web service
re-seeds the employee roster; the audit log and app config are in SQLite on the
volume and survive.

## Security posture, in one place

For whoever has to review this before it goes on your network:

- **Secrets.** Two API keys, read from the environment on the server only. No key
  is baked into an image, written to the database, logged, or sent to the
  browser — the client fetches only same-origin BFF routes.
- **Egress.** One destination: `ANTHROPIC_BASE_URL`. One client module. No
  telemetry, no analytics, no update check, no CDN fetches at runtime.
- **Data at rest.** One SQLite file you own. It holds names, work emails,
  reporting lines, spend figures and the audit log. No personal data leaves the
  host except in the API calls the app was pointed at.
- **Authentication.** Delegated entirely to your proxy in `proxy` mode; the app
  trusts `AUTH_HEADER` and has no session of its own. `AUTH_MODE=dev` is
  authentication-free by design; an unrecognised `AUTH_MODE` throws at startup
  rather than falling back to either.
- **Authorisation.** Enforced server-side in `permissions.ts`, on every render
  and every route, against the roster — not in the client, and not by hiding UI.
- **Audit.** Every write, successful or failed, with actor, target, old and new
  values, and the upstream request id. Append-only, no foreign key to
  `employees`, so removing a person does not erase what they did.
- **Blast radius, honestly.** The Admin key can change any limit in the
  organization. Anyone who can reach the app while `AUTH_MODE=proxy` is set and
  spoof the header is an admin of this app; anyone who can read the container's
  environment has the key itself.

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
> and they would land on a **real organization**.
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
| `DEV_DEFAULT_EMAIL` | — | **Dev mode only.** Who a visitor with no impersonation cookie becomes, so a fresh clone opens on a populated page instead of the "not provisioned" 403. A cookie always wins, including one that names nobody. Setting this with `AUTH_MODE=proxy` is a startup error. |
| `DATABASE_PATH` | `./data/app.db` | SQLite file. Relative paths resolve against the working directory, which is `apps/web` for every command that opens it. |

### `apps/mock-api`

Synthetic data only. It ships as its own image and *is* deployed — it is what
[the hosted sandbox](#the-hosted-sandbox) talks to — but it has no place in a
stack that also holds a real Admin key.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Port the mock listens on. |
| `MOCK_ADMIN_KEY` | `mock-admin-key` | Key the spend-limits surface accepts. |
| `MOCK_ANALYTICS_KEY` | `mock-analytics-key` | Key the analytics surface accepts. |
| `MOCK_SEED` | `42` | Seed for the synthetic organization. 42 is what the test fixtures refer to. |
| `MOCK_RATE_LIMIT` | `off` | `off`, or requests per minute. Set a number to rehearse hitting the real 60/min org limit. |

`.env.example` at the repo root carries the same list in copyable form.
`apps/web/.env.development` is checked in and already points at the mock, so a
fresh clone needs no configuration.

## Mock fidelity, and how to check it

`apps/mock-api` implements the documented contract closely — the resolution
precedence for effective limits, upsert keyed on (scope, period), cursors bound
to the query parameters that issued them, approve-writes-an-override-and-resolves,
idempotent deny, the 60/min rate limit, the `data_refreshed_at` watermark and the
revision of provisional rows. The web app's own integration tests run against it
over real HTTP rather than against stubs, which is also what makes it useful to
your fork: CI has a full API to test against without a key.

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

**`npm run verify:api` closes the loop**, and is the first thing to run against
your own organization's keys before you trust a fork of this in production. It
points the real client at the real API and checks every returned row against the
schemas in `packages/shared`:

```bash
ANTHROPIC_ADMIN_KEY=… ANTHROPIC_ANALYTICS_KEY=… npm run verify:api
```

It issues three GETs — the first page of effective limits, the first page of
increase requests, and a 7-day cost report — and nothing else. The `fetch` it
uses throws on any non-GET request, so it cannot mutate an organization even if
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

The tests are the documentation of intent for the parts you are most likely to
change: `permissions.test.ts` states the access rules as assertions,
`import-employees.test.ts` states what a valid roster is, and `money.test.ts`
states why the amounts are strings. Adapt those first and let them tell you what
you broke.

## License

MIT — see [LICENSE](./LICENSE). Fork it, rename it, run it internally, keep your
changes. There is no contributor licence agreement and no upstream service to
stay compatible with.

Not an official Anthropic product. "Claude" and "Anthropic" are trademarks of
Anthropic PBC, used here only to describe what this tool talks to.
