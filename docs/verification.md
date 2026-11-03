# Verification record

Date of runs: 2026-11-03 (sandbox). This file separates what was run and passed, what was checked live
against real infrastructure, and what still needs external accounts or network access.

Raw logs are kept in `docs/evidence/`:

| File | Contents |
| --- | --- |
| `integration-and-unit-final.log` | Final `vitest run --project unit --project integration` output |
| `e2e-playwright-final.log` | Final `pnpm test:e2e` output (Playwright, Chromium) |
| `api-bundle-startup.log`, `worker-live.log`, `dispatcher-live.log`, `local-sink.log` | Live run of the production bundles |

## Environment

| Component | Version / setting |
| --- | --- |
| Node.js | 22.23.4 |
| pnpm | 10.28.0 (`packageManager` pin) |
| PostgreSQL | 16.4-alpine (Docker, named volume `pg-data`) |
| Redis | 7.4-alpine, `appendonly yes`, `appendfsync everysec`, `maxmemory-policy noeviction` |
| Elasticsearch | 8.15.3 single node, security disabled (local only) |
| Playwright | 1.64.1, Chromium from `/opt/pw-browsers/chromium` (`PLAYWRIGHT_CHROMIUM_EXECUTABLE`) |
| SMTP for tests and the live run | Controlled SMTP sink (`tests/fixtures/smtp-sink.ts`) speaking real SMTP over TCP |
| Webhooks for tests | Local HTTP server standing in for Slack incoming webhooks |

Ethereal (`api.nodemailer.com`) and Slack (`slack.com`) are not reachable from the build sandbox, so no
test used them. Google's OpenID discovery document is reachable and was used live (see below).

## Automated checks (run and passed)

| Command | Result |
| --- | --- |
| `pnpm lint` | Pass (ESLint flat config, all workspace packages) |
| `pnpm typecheck` | Pass (strict TypeScript for backend packages and the web app) |
| `pnpm build` | Pass (`apps/api/dist/main.js`, `apps/worker/dist/main.js`, `apps/dispatcher/dist/main.js`, web bundle) |
| `pnpm test` (unit) | Pass, 21 of 21 |
| `pnpm test:integration` | Pass, 41 of 41 |
| `pnpm test:e2e` | Pass, 4 of 4 |

Final unit and integration totals: **62 of 62 passed** (see the last section and `docs/evidence/integration-and-unit-final.log`).

### Integration coverage against the plan's required tests

Each row names the test file. All run against real PostgreSQL 16, Redis 7 and Elasticsearch 8, with an
SMTP sink for delivery.

| Requirement | Covered by | What is asserted |
| --- | --- | --- |
| Repeated API request with the same key and payload creates one campaign | `api.test.ts` | Replay returns the same campaign with `replayed: true`; no extra emails |
| Different payload under the same key is rejected | `api.test.ts` | `409 IDEMPOTENCY_KEY_REUSED` |
| Concurrent double submit never doubles recipients | `api.test.ts` | Six simultaneous identical requests yield one campaign and three emails |
| Duplicate queue delivery does not send twice | `delivery.test.ts`, `outbox.test.ts` | Replayed outbox publication keeps three BullMQ jobs; a terminal email is a no-op |
| Two workers sharing a sender | `delivery.test.ts` | Two concurrent workers on one sender: at most one SMTP transaction open at a time (`maxConcurrentData = 1`), six unique messages |
| Sender and campaign limits | `delivery.test.ts` | Sender cap 2 defers the third email to the next UTC hour; campaign cap 1 defers the second; both scopes record a threshold event |
| Threshold event exactly once | `delivery.test.ts` | Further attempts in the same hour create no second event |
| Shared quota under a race | `delivery.test.ts` | Ten concurrent attempts against a cap of 3 deliver exactly 3 |
| Pacing and deferral without consuming retries | `delivery.test.ts` | Minimum-gap deferral does not change hourly usage; release after the gap |
| Deterministic UTC hour boundary | `delivery.test.ts` | Deferred at 10:59:59.999; released at 11:00:00.000 (manual clock) |
| Restart without shifting due times | `outbox.test.ts`, live run below | Reconciliation leaves existing jobs' timestamps unchanged; live Redis and process restarts keep the delayed set identical |
| Crash after enqueue, before outbox acknowledgement | `outbox.test.ts` | Replay yields one job per email |
| Crash while holding an outbox lease | `outbox.test.ts` | Expired lease is re-leased and published |
| Stale lease token cannot mark rows published | `outbox.test.ts` | Old token's acknowledgement has no effect |
| Missing job rebuilt, healthy job untouched | `outbox.test.ts` | Only the missing job is re-created |
| Crash before SMTP | `delivery.test.ts` | Stale `STARTED` attempt becomes `DELIVERY_UNCERTAIN`; SMTP is never contacted |
| Ambiguous SMTP outcome is never resent | `delivery.test.ts` | Connection dropped mid-DATA: `DELIVERY_UNCERTAIN`; second attempt is a no-op; sink transaction count unchanged |
| Definite rejection | `delivery.test.ts` | `550` from the sink becomes `FAILED` with a stored SMTP detail |
| Slack not connected at threshold | `delivery.test.ts`, `slack.test.ts` | Event recorded `SKIPPED_NOT_CONNECTED`; no outbox notification |
| Slack message content | `slack.test.ts` | Names sender, cap and UTC window; contains no email address |
| Slack 429 honours `Retry-After` | `slack.test.ts` | `RETRY_AFTER` 2000 ms; then delivered |
| Slack transient and permanent failures | `slack.test.ts` | 503 retried, recorded `FAILED` on the final attempt; 404 recorded `FAILED` without retry |
| Disconnect and reconnect without restart | `slack.test.ts` | Skipped history is not replayed; the first event after reconnect is delivered |
| Slack OAuth exchange validation | `slack.test.ts` | Stubbed Slack responses: valid installation parsed; `ok: false` and missing webhook rejected |
| Search over scheduled and sent emails | `pipeline.test.ts` | Elasticsearch finds `SENT` and scheduled documents through the API |
| Workspace isolation | `api.test.ts`, `pipeline.test.ts` | Another workspace cannot list, open, preview, schedule with, or search the owner's records |
| Search outage does not affect listings | `api.test.ts` | Unreachable Elasticsearch returns `503 SEARCH_UNAVAILABLE`; the email list still returns 200 |
| Bull Board access | `api.test.ts` | Anonymous 401; signed-in non-operator 403; allowlisted operator 200 |
| CSRF and origin checks | `api.test.ts` | Missing token 403; foreign `Origin` 403 |
| Payload size limit | `api.test.ts` | Body over the limit returns 413 |
| 1,000 synthetic recipients | `scale.test.ts` | Cap 500 per hour: 500 sent and 500 deferred in hour one (one sender and one campaign event); all 1,000 sent in hour two; 1,000 unique messages; no overshoot. Sink, not Ethereal |
| Recipient normalisation and CSV feedback | `pure.test.ts` | BOM stripped; local-part case preserved; domain lowercased; blanks, duplicates and malformed addresses counted |
| Configuration | `pure.test.ts` | Defaults applied; short encryption key or session secret refused |

### Browser smoke suite (Playwright, against the real stack)

The Playwright configuration starts the API, the worker, the outbox dispatcher and the Vite dashboard. A
test fixture creates a session in the test database (this is a test fixture, not a login route; Google sign-in
was not exercised in the browser).

| Test | Result |
| --- | --- |
| Signed-in profile, both senders, Slack status | Pass |
| Import with header row, blank row, duplicate and malformed address; malformed address blocks scheduling; server counts the duplicate; scheduled emails are delivered and appear under Sent; detail dialog shows SMTP acceptance and Message ID; Escape closes it | Pass |
| Future email stays under Scheduled and is found by Elasticsearch search | Pass |
| 390 px wide layout: no page-level horizontal scrolling (wide tables scroll inside their own container) | Pass |

## Live checks (real infrastructure; this sandbox)

| Check | Result |
| --- | --- |
| Compose services healthy (PostgreSQL, Redis, Elasticsearch) | Pass |
| `pnpm db:migrate` applied `0001_init.sql` | Pass |
| Production API, worker and dispatcher bundles start from `dist/` | Pass (API started with placeholder OAuth IDs; see the Google line below) |
| `GET /health/ready` reports PostgreSQL, Redis and Elasticsearch OK | Pass |
| `GET /auth/google` redirects to `accounts.google.com` with a real discovery document, S256 PKCE, `state` and `nonce`, `openid email profile` | Pass (redirect only; consent not completed) |
| Anonymous `/api/me` and `/admin/queues` | 401 |
| `POST /auth/logout` without CSRF token | 403 |
| Replayed or forged OAuth callback `state` | Redirected to `?auth=expired`; nothing stored |
| Due emails through the live pipeline (API → outbox → BullMQ → worker → SMTP sink) | Two emails SENT |
| Future emails | Three delayed BullMQ jobs with staggered due times (60 s gap) |
| **Redis restart** (`docker compose restart redis`, volumes kept) | Delayed set identical before and after: same job IDs and scores |
| **Worker and dispatcher restart** | Delayed set identical; zero unpublished outbox rows; persisted sender counter unchanged |
| **Live cap**: sender cap set to 2, three due emails | Two SENT; third `DEFERRED` with `SENDER_HOURLY_CAP`, next attempt at 11:00 UTC; one `SENDER` threshold event with Slack status `SKIPPED_NOT_CONNECTED` |

Test data and runtime state were written to the development database and to the Redis and
Elasticsearch instances started for this sandbox. Nothing was published or sent to a real recipient.

## Not verified (external inputs required)

| Item | What is needed | Current state |
| --- | --- | --- |
| Google consent, token exchange, real signed-in session | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, consent screen with the account as a test user, redirect `http://localhost:5173/auth/google/callback` | The redirect was produced from Google's live discovery document. Consent and token exchange were not run. The session used in browser tests is a fixture. |
| Slack OAuth installation and channel post | Slack app with `incoming-webhook`, `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET`, a test workspace, redirect `http://localhost:5173/auth/slack/callback` | Not reachable from the sandbox. Exchange and message handling are covered by stubbed tests only. |
| Slack 429 from Slack and `auth.revoke` | Live Slack workspace | Covered by a local webhook stand-in only. |
| Ethereal senders and preview URLs | Network access to `api.nodemailer.com`; run `pnpm seed:ethereal` | Not reachable from the sandbox. `previewUrlFor` is not exercised by any test. The local sink returns no preview. |
| Figma design fidelity | Accessible Figma file or exported frames | No Figma tool or connection is available to this session, and the file is not accessible from the available connectors. Styling is provisional and labelled as such in `apps/web/src/index.css`. |
| Elasticsearch outage recovery and full reindex on live data | Running `pnpm search:reindex` against a populated index | Outage behaviour is covered by a test. The reindex command is implemented but was not run on live data. |
| Demo recording | User participation with the live accounts | Script in `docs/demo/DEMO.md`; not recorded. |

## Defects found and fixed during verification

These were found by running the suites and corrected in the code or tests. They are listed so a reviewer can see
what changed, not hidden.

1. **Bundled production processes could not start.** The esbuild step left npm packages external, and pnpm's strict
   `node_modules` layout hid them from the app directories. Fixed by bundling npm dependencies in `scripts/build.mjs`,
   and by declaring `@bull-board/ui` in `apps/api` (Bull Board loads UI assets from disk).
2. **Phone layout overflowed the viewport.** A grid track sized to content, an un-contained `sr-only` label and an
   unconstrained table wrapper pushed the document wider. Fixed with `minmax(0, 1fr)` tracks, `min-w-0` on grid
   children and `relative` on the scrolling table wrapper.
3. **The import form deduplicated before sending.** The server therefore reported zero duplicates. The client now sends
   the raw valid lines and the server's deduplication count is authoritative.
4. **The schedule button rejected starts that were valid to the minute.** The `datetime-local` input truncates seconds,
   so the allowed past window is now five minutes.
5. **The e2e stack did not start the worker or dispatcher.** Playwright skipped `webServer` entries that shared a readiness
   URL. Fixed by starting the three backend processes from one launcher (`tests/e2e/run-stack.mjs`).
6. **Test interference.** Two Vitest runs writing to one test database caused deadlocks. Resolved by running one suite at
   a time. Test Redis is now flushed (guarded to database `/1`) instead of obliterating queues, which had become slow.
7. **Two timing-dependent tests** asserted state that depended on wall-clock hour boundaries. They now make the email due
   explicitly, which tests the cap rather than the clock.

## Final totals

Copied from `docs/evidence/integration-and-unit-final.log` after the last run:

```
 Test Files  7 passed (7)
      Tests  62 passed (62)
```

Breakdown: unit 21 (`tests/unit/pure.test.ts`); integration 41 (`delivery` 13, `outbox` 6, `pipeline` 1, `api` 12, `slack` 8, `scale` 1).

## Commands to reproduce

```bash
pnpm infra:up
pnpm db:migrate
pnpm lint && pnpm typecheck && pnpm build
pnpm test
pnpm test:integration          # real PostgreSQL, Redis and Elasticsearch; takes about 3 minutes (scale test)
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium pnpm test:e2e   # omit the variable if Playwright's own browser is installed
```

`pnpm test:integration` uses database `reachinbox_test` and Redis database `/1`, both created by the global setup.
It never runs against the development database.
