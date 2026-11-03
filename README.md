# ReachInbox email scheduler

A full-stack outbound email scheduler: Google sign-in, a React dashboard, scheduled campaigns from CSV/text imports, durable delayed delivery through BullMQ, multiple Ethereal SMTP senders, a transactional outbox, Elasticsearch search over scheduled and sent mail, a live operator queue board, and Slack cap alerts over a real OAuth installation.

> **Status at a glance.** Final run: unit and integration 62 of 62 passed (real PostgreSQL, Redis and Elasticsearch, with an SMTP sink and a webhook stand-in); browser smoke 4 of 4 passed; lint, typecheck and build pass. Details, raw logs and the live checks are in [`docs/verification.md`](docs/verification.md). Live Google consent, Slack installation and Ethereal provisioning need your accounts and network access and are listed there as pending.

## Contents

- [Quick start](#quick-start)
- [Environment variables](#environment-variables)
- [OAuth setup and redirect URIs](#oauth-setup-and-redirect-uris)
- [Commands](#commands)
- [Architecture](#architecture)
- [Persistence and restarts](#persistence-and-restarts)
- [Limits, UTC semantics and concurrency](#limits-utc-semantics-and-concurrency)
- [Delivery guarantees and trade-offs](#delivery-guarantees-and-trade-offs)
- [Search, Slack and the queue board](#search-slack-and-the-queue-board)
- [Requirement mapping](#requirement-mapping)
- [Known limitations](#known-limitations)
- [Demo](#demo)
- [Design status](#design-status)

## Quick start

Prerequisites: Node.js 22.12+, pnpm 10 (`corepack enable`), Docker with Compose.

```bash
pnpm install
cp .env.example .env
# Generate two secrets and paste them into .env
node -e "console.log('ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log('SESSION_SECRET=' + require('crypto').randomBytes(32).toString('base64url'))"

pnpm infra:up          # PostgreSQL 16.4, Redis 7.4 (AOF), Elasticsearch 8.15.3 — named volumes, health checks
pnpm db:migrate        # applies packages/db/migrations
pnpm seed:ethereal     # creates SENDER_COUNT Ethereal accounts once and stores them encrypted
pnpm dev               # API :3001, worker, dispatcher, web :5173
```

Open <http://localhost:5173> and sign in with Google (requires the Google setup below). Then compose a campaign.

Run the processes separately if you prefer: `pnpm dev:api`, `pnpm dev:worker`, `pnpm dev:dispatcher`, `pnpm dev:web`.

## Environment variables

All variables are read from `.env` (git-ignored) or the process environment. The API, worker and dispatcher validate the full configuration at startup and report every invalid key. See `.env.example` for a copy-paste template and `.env.demo.example` for the low-limit demo profile.

| Variable | Default | Used by | Purpose |
| --- | --- | --- | --- |
| `NODE_ENV` | `development` | all | `production` disables the dev-only session helper. |
| `LOG_LEVEL` | `info` | all | pino level. |
| `DATABASE_URL` | — (required) | all | PostgreSQL connection string. |
| `REDIS_URL` | `redis://localhost:6379` | all | BullMQ and rate-limit/outbox transport. |
| `ELASTICSEARCH_URL` | `http://localhost:9200` | API, worker, scripts | Search and indexing. |
| `ELASTICSEARCH_INDEX` | `emails-v1` | API, worker, scripts | Index name; change it to force a fresh index plus reindex. |
| `APP_PUBLIC_URL` | `http://localhost:5173` | API | Public origin. Builds the OAuth redirect URIs. |
| `WEB_ORIGIN` | `http://localhost:5173` | API | Allowed origin for CORS and CSRF `Origin` checks. |
| `API_PORT` | `3001` | API | HTTP port. |
| `API_PROXY_TARGET` | `http://localhost:3001` | web (Vite) | Where `/api`, `/auth`, `/admin` are proxied. |
| `SESSION_TTL_HOURS` | `12` | API | Server-side session lifetime. |
| `SESSION_COOKIE_SECURE` | `false` | API | Set `true` behind HTTPS. |
| `SESSION_SECRET` | — (required, ≥32 chars) | API | HMAC key for session token hashes. |
| `ENCRYPTION_KEY` | — (required) | API, worker, scripts | 32 random bytes, base64. Encrypts SMTP configs, webhook URLs and Slack tokens. **Losing it makes stored secrets unreadable.** |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | empty | API | Google OAuth web client. Without them `/auth/google` returns 503. |
| `GOOGLE_OIDC_ISSUER` | `https://accounts.google.com` | API | OIDC issuer. |
| `OPERATOR_EMAILS` | empty | API | Comma-separated emails allowed to open `/admin/queues` (read-only). |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` | empty | API | Slack app credentials. Without them Connect Slack is disabled. |
| `WORKER_CONCURRENCY` | `5` | worker | Concurrent email jobs per worker process. |
| `MIN_SEND_DELAY_MS` | `2000` | seed, provisioning | Minimum gap between SMTP attempts from one sender. Copied to sender rows. |
| `MAX_EMAILS_PER_HOUR_PER_SENDER` | `200` | seed, provisioning | Protective hourly cap per sender (all campaigns). Copied to sender rows; `pnpm seed:ethereal` re-syncs it. |
| `SENDER_COUNT` | `2` | `seed:ethereal` | Number of Ethereal accounts to keep provisioned. |
| `SMTP_CONNECTION_TIMEOUT_MS` / `SMTP_GREETING_TIMEOUT_MS` / `SMTP_SOCKET_TIMEOUT_MS` | `10000` / `10000` / `20000` | worker | Socket deadlines. The attempt deadline is their sum plus 5 s. |
| `MAX_RECIPIENTS_PER_CAMPAIGN` | `10000` | API | Upper bound on recipients per campaign. |
| `MAX_JSON_BODY_BYTES` | `5242880` | API | Request body limit (5 MB). |
| `DISPATCHER_BATCH_SIZE` | `200` | dispatcher | Outbox rows leased per batch. |
| `OUTBOX_LEASE_MS` | `30000` | dispatcher | Lease duration; expired leases are re-leased. |
| `POSTGRES_HOST_PORT`, `REDIS_HOST_PORT`, `ELASTICSEARCH_HOST_PORT` | `5432`, `6379`, `9200` | Compose | Host port mapping. |

## OAuth setup and redirect URIs

For local development, set `APP_PUBLIC_URL=http://localhost:5173`. The Vite dev server proxies `/auth` and `/api` to the API, so the session cookie stays same-origin.

**Google** (Google Cloud Console → APIs & Services → Credentials → OAuth client ID, type *Web application*):

- Authorized redirect URI: `http://localhost:5173/auth/google/callback`
- Scopes requested: `openid email profile`
- Consent screen: add your account as a **test user** while the app is in *Testing*.

**Slack** (api.slack.com → your app → OAuth & Permissions):

- Redirect URL: `http://localhost:5173/auth/slack/callback`
- Bot/user scope: **only** `incoming-webhook` is requested by the app.
- Install the app into a test workspace and allow it to post to a channel. The install flow asks you to choose the channel.

For any other deployment, change `APP_PUBLIC_URL` and register the matching callbacks.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm infra:up` / `pnpm infra:down` | Start/stop Postgres, Redis, Elasticsearch (never deletes volumes). |
| `pnpm db:migrate` | Apply SQL migrations (advisory-locked, idempotent). |
| `pnpm seed:ethereal` | Provision Ethereal sender accounts once; re-syncs caps; copies senders into workspaces. |
| `pnpm seed:local-sink` | **Offline fallback only**: points senders at a local SMTP sink (see `dev:smtp-sink`). Not Ethereal. |
| `pnpm dev:smtp-sink` | Local SMTP sink on port 2525 for offline demos. |
| `pnpm dev:session -- you@example.com` | Local verification helper: creates a session cookie without Google. Refused when `NODE_ENV=production`. |
| `pnpm dev` | API, worker, dispatcher and web together. |
| `pnpm search:reindex` | Rebuild the Elasticsearch index from PostgreSQL. |
| `pnpm lint` / `pnpm typecheck` | ESLint (flat config) and strict TypeScript across all packages. |
| `pnpm build` | Bundles API, worker and dispatcher to `apps/*/dist` and builds the web app. |
| `pnpm start:api` / `pnpm start:worker` / `pnpm start:dispatcher` | Run the built bundles. |
| `pnpm test` | Unit tests (pure logic). |
| `pnpm test:integration` | Real PostgreSQL/Redis/Elasticsearch plus an in-process SMTP sink and webhook server. |
| `pnpm test:e2e` | Playwright browser smoke test. It starts the API, worker, dispatcher and dashboard itself (`tests/e2e/`). Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` only if the Playwright-bundled browser is not installed. |
| `pnpm test:all` | Unit, integration and browser tests in sequence. |

## Architecture

Full description and trade-offs: [`docs/architecture.md`](docs/architecture.md).

```
apps/api          Express + Zod: auth, sessions, CSRF, campaigns, listings, search, health, Bull Board
apps/worker       BullMQ workers: email delivery, search indexing, Slack notifications
apps/dispatcher   Transactional outbox → BullMQ publication; stale-attempt recovery; boot reconciliation
apps/web          React + Vite + Tailwind single-page dashboard with TanStack Query
packages/contracts Zod request schemas, DTOs, status vocabulary, recipient normalisation (shared)
packages/core     Config, crypto, clock, queues, SMTP, delivery state machine, outbox, search, Slack
packages/db       pg pool, transactions, migration runner, SQL migrations
tests/            unit, integration, e2e (Playwright), fixtures (SMTP sink, webhook server, harness)
scripts/          migrate, seed-ethereal, reindex, build
docs/             architecture, verification, demo script, sample leads
```

Repository layout follows the plan's `apps/*`, `packages/*` and `tests/*` split. Deliberate departures from the plan are listed under [Known limitations](#known-limitations): raw SQL migrations instead of Prisma, no client-side router (the dashboard is one screen with modals), and the Figma design not inspected.

## Persistence and restarts

- PostgreSQL is authoritative: campaigns, emails, attempts, counters, outbox, sessions, Slack state. Use named volume `pg-data`.
- Redis runs with `appendonly yes`, `appendfsync everysec` and `maxmemory-policy noeviction`, so delayed BullMQ jobs survive a container restart. With `everysec`, a host crash can lose roughly the last second of queue writes; boot reconciliation rebuilds jobs for pending emails that have no SMTP attempt, from PostgreSQL.
- Elasticsearch is a derived index (`es-data`). Losing it costs search only; `pnpm search:reindex` rebuilds it.
- Restarting the API or worker does not shift due times: each job's delay is computed from the stored `next_attempt_at`, and healthy jobs are never re-timed.
- **Never run `docker compose down -v` while demonstrating durability.** It deletes the volumes.

## Limits, UTC semantics and concurrency

- Times are stored as `timestamptz`. The browser converts the local `datetime-local` value to a UTC ISO instant ending in `Z` before submission, and the server rejects anything else.
- Hourly counters use fixed UTC hour windows. The permit transaction derives the window from the injected clock, and tests exercise the 10:59:59.999 → 11:00:00.000 boundary deterministically.
- Recipient limit: 10,000 per campaign (configurable). Body: 20,000 characters. Subject: 300. Request body: 5 MB.
- Concurrency: `WORKER_CONCURRENCY` parallel jobs per worker process; any number of worker and dispatcher processes can run together. A per-sender in-flight marker allows one SMTP transaction per sender at a time.
- Deduplication: recipients are unique per campaign. The domain is case-normalised; the local part is case-sensitive (documented policy).

## Delivery guarantees and trade-offs

- **At most one SMTP submission per email.** Automatic resend is disabled. See [`docs/architecture.md`](docs/architecture.md#smtp-at-most-once-policy-explicit-trade-off).
- An email that was recorded as attempted but whose outcome is unknown is shown as **Uncertain (not resent)**. It can be a message that was accepted but not recorded, or one that never left. ReachInbox does not decide this for you, and there is no one-click resend in this scope.
- A worker death between permit and SMTP leaves a `STARTED` attempt that recovery marks uncertain. This can leave a message unsent. We chose duplicate prevention over lossless retry.
- Ethereal accepts mail but does not deliver to real recipients. "Sent" means accepted by Ethereal SMTP.
- Fixed UTC windows allow up to twice the cap across an hour boundary; the minimum gap still applies across it.
- Ordering across parallel workers is best effort. Strict FIFO is out of scope.

## Search, Slack and the queue board

- **Search** (`GET /api/emails/search`) uses Elasticsearch with server-side workspace filters, cursor pagination and external document versions. It is eventually consistent (about one second after an outbox publication). When Elasticsearch is down, search returns `503 SEARCH_UNAVAILABLE` and the rest of the app keeps working.
- **Slack** cap alerts are posted through an installed incoming webhook. A message names the sender or campaign, the cap, the UTC window and the next retry time. It contains no email bodies or recipients.
  - A disconnected workspace records the threshold as skipped; scheduling continues. Reconnecting takes effect immediately and does not replay skipped events.
  - Disconnect revokes the retained OAuth token where Slack allows it. The webhook URL itself stays valid in Slack until removed there.
  - An ambiguous HTTP timeout can produce a duplicate message on retry.
- **Bull Board** is mounted at `/admin/queues`, read-only, for operators in `OPERATOR_EMAILS` only. Non-operators receive `403`; anonymous requests receive `401`.

## Requirement mapping

| Requirement | Where | Verified by |
| --- | --- | --- |
| Real Google login, server-side sessions, CSRF | `apps/api/src/routes/auth.ts`, `http/session.ts` | Partially: `/auth/google` redirect and state path exercised; live consent pending (see verification). |
| Multiple saved Ethereal senders | `scripts/seed-ethereal.ts`, `sender_pool` | Script implemented; live provisioning pending network access. Pipeline verified with a local sink. |
| Future emails scheduled via BullMQ delayed jobs | `apps/dispatcher`, `packages/core/src/outbox`, `apps/worker` | `tests/integration/pipeline.test.ts`, `outbox.test.ts` |
| Transactional outbox with stable job IDs | `packages/core/src/outbox/dispatch.ts`, `queue.ts` | `outbox.test.ts` (crash-after-enqueue, lease expiry) |
| DB-enforced API idempotency | `apps/api/src/services/campaigns.ts`, `0001_init.sql` | `api.test.ts` (replay, conflict, concurrent duplicates) |
| Two-worker safety and sender caps | `packages/core/src/delivery/permit.ts` | `delivery.test.ts` (serialisation, cap race) |
| Campaign limits independent of sender caps | same | `delivery.test.ts` |
| Threshold event exactly once, Slack on reach | `permit.ts`, `slack/index.ts` | `delivery.test.ts`, `slack.test.ts` |
| Deferral without retry consumption | `apps/worker/src/processors.ts` (`moveToDelayed` + `DelayedError`) | `delivery.test.ts` (deferral reasons) |
| Ambiguous outcomes never resent; visible as uncertain | `settle.ts`, `recovery.ts` | `delivery.test.ts` (drop@, stale attempt) |
| 1,000 recipients accounted for, no quota overshoot | `scale.test.ts` | integration |
| Elasticsearch scheduled + sent search, workspace isolation | `search/index.ts`, `services/emails.ts` | `pipeline.test.ts`, `api.test.ts` |
| Slack OAuth + live webhook, reconnect without redeploy | `routes/auth.ts`, `slack/index.ts` | `slack.test.ts` (live Slack pending) |
| Protected live Bull Board | `app.ts` | `api.test.ts` |
| Dashboard: Scheduled/Sent, compose, import, search, Slack, states | `apps/web/src` | `dashboard.spec.ts` (Playwright) |

## Known limitations

- **Live OAuth and Ethereal were not exercised from the build sandbox.** The sandbox could not reach `api.nodemailer.com` or `slack.com`. See the verification document for what was and was not run.
- **Figma design was not inspected.** The connected account lacks edit access to the Figma file, and no Figma tool is attached to this session. The UI is functional and accessible, but its styling is provisional and must be compared with the design once access is available.
- **Raw SQL migrations instead of Prisma.** The plan allowed Prisma; we chose plain `pg` with explicit SQL so row locks (`FOR UPDATE SKIP LOCKED`), counters and the outbox are visible in code. The schema is in `packages/db/migrations`.
- No client-side router: the dashboard is a single screen with modal dialogs, so there are no deep links to individual emails. The plan's React Router dependency was not needed for this scope.
- Single workspace per Google account; no team sharing.
- No open/click tracking, bounce handling or unsubscribe management (sandbox scope).
- Fixed-window rate limiting allows boundary bursts (documented above).
- `pnpm dev:session` and `scripts/seed-local-sink.ts` are local verification helpers and are not part of the product path.

## Demo

A five-minute recording script with timestamps is in [`docs/demo/DEMO.md`](docs/demo/DEMO.md). The sample file [`docs/demo/sample-leads.csv`](docs/demo/sample-leads.csv) contains a BOM, a header, a quoted name, a blank row, a duplicate and a malformed address on purpose.

## Design status

Styling is provisional. See the note in `apps/web/src/index.css` and the known-limitations section above.
