# Architecture and design decisions

## Processes

| Process | Entrypoint | Responsibility |
| --- | --- | --- |
| API | `apps/api/src/main.ts` | Express HTTP: Google/Slack OAuth, sessions, campaign intake, listings, search, health, Bull Board (operator-only). Never sends email. |
| Email worker (+ index and notify workers) | `apps/worker/src/main.ts` | BullMQ workers: `email-delivery` (SMTP), `search-index` (Elasticsearch bulk), `slack-notify` (webhooks). |
| Outbox dispatcher | `apps/dispatcher/src/main.ts` | Leases committed outbox rows and publishes stable BullMQ job IDs; runs stale-attempt recovery and boot reconciliation. No sending. |
| Web | `apps/web` (Vite) | React dashboard. Talks only to the API through the Vite proxy (same origin, cookies stay HttpOnly). |

Each Node process is independently restartable. They share service modules from `packages/core` and the schema in `packages/db`.

```
Browser ──► API ──► PostgreSQL  (authoritative state, counters, outbox, attempts)
                 └─► (reads)  Elasticsearch (search only)
Dispatcher ──► PostgreSQL outbox ──► Redis/BullMQ (delayed email jobs, index jobs, notify jobs)
Worker ──► Redis/BullMQ ──► PostgreSQL (permit / settle) ──► SMTP (Ethereal)
Worker ──► Elasticsearch (bulk, external versions)   Worker ──► Slack webhook (threshold alerts)
```

## Durable scheduling

1. `POST /api/campaigns` validates the payload, deduplicates recipients, and in **one transaction** inserts the campaign, every email (`SCHEDULED`, due at `startAt + sequence × gap`), and two outbox rows per email (`enqueue:<emailId>`, `index:<emailId>:1`). The API returns `202` after COMMIT. Queue publication is reported separately as `enqueue.published / total`.
2. The dispatcher leases outbox rows with `FOR UPDATE SKIP LOCKED` and a lease expiry, publishes BullMQ jobs with IDs derived from those keys (`email-<uuid>`, `index-<sha256>`, `slack-<uuid>`), and then marks them published under the lease token. A crash at any point is safe: replays hit the same job IDs, which BullMQ de-duplicates, and the worker re-checks the database anyway.
3. Email jobs are created with `delay = next_attempt_at − now`. BullMQ owns timing. There are no sleep loops and no cron.
4. Boot reconciliation pages through pending emails that have **no** SMTP attempt and rebuilds only the jobs that are missing (or finished/failed without an attempt). Healthy jobs are never re-timed.

## Email state machine

```
SCHEDULED ──(due, permit granted)──► SENDING ──(SMTP accepted)──► SENT
    │  ▲                               │ │  └─(definite rejection)─► FAILED
    │  └─(retry later, no attempt)─┐   │ └─(ambiguous / stale)───► DELIVERY_UNCERTAIN
    ▼                              │   └─ (never resent automatically)
DEFERRED ─────────────────────────┘
  reasons: NOT_YET_DUE, SENDER_IN_FLIGHT, SENDER_PACING, CAMPAIGN_PACING,
           SENDER_HOURLY_CAP, CAMPAIGN_HOURLY_CAP
```

Scheduled view = `SCHEDULED`, `DEFERRED`, `SENDING`. Sent view = `SENT`, `FAILED`, `DELIVERY_UNCERTAIN`.

## Permit transaction (`packages/core/src/delivery/permit.ts`)

Lock order is always **sender → campaign → email**, so concurrent workers cannot deadlock. No network I/O happens inside the transaction. In order it checks:

1. terminal status → SKIP; an existing attempt or `SENDING` → SKIP;
2. `next_attempt_at` in the future → DEFER (`NOT_YET_DUE`);
3. the sender's in-flight marker → DEFER (`SENDER_IN_FLIGHT`, +1 s);
4. sender pacing (`next_allowed_at`) and campaign pacing → DEFER until that instant;
5. sender hourly counter and campaign hourly counter for the current **UTC hour** → DEFER until the next UTC hour boundary.

If all pass it, in the same transaction, it inserts the single `STARTED` attempt for the email (`UNIQUE(email_id)`), increments both hourly counters, inserts a threshold event when a counter reaches its cap (`UNIQUE(scope, scope_id, hour)`, so exactly once), queues the Slack notification in the same commit when Slack is connected (otherwise the event is recorded as `SKIPPED_NOT_CONNECTED`), sets the sender's in-flight marker and pacing, and moves the email to `SENDING`.

A DEFER is applied with `job.moveToDelayed(nextAt, token)` followed by `DelayedError`. It does **not** consume an SMTP attempt or the BullMQ retry budget.

## SMTP at-most-once policy (explicit trade-off)

PostgreSQL and SMTP cannot commit atomically. The implementation therefore chooses **no automatic second SMTP submission**:

- The `STARTED` attempt is committed before the SMTP call.
- nodemailer pooling and retries are disabled; there is exactly one `sendMail` per attempt.
- Outcomes: `250` accepted → `SENT` (with Message-ID and Ethereal preview). Server reply code (4xx/5xx) or pre-connection failures (`ECONNREFUSED`, `ENOTFOUND`, `EAUTH`) → `FAILED`. Timeouts, resets and anything after the transaction started → `DELIVERY_UNCERTAIN`.
- If a worker dies after committing `STARTED` but before SMTP, recovery marks the attempt `UNCERTAIN` once its deadline passes. **This means a message can be left unsent**, and it is shown as uncertain, not silently lost.
- Settlement is conditional on `status = 'STARTED'`, so a late success can never overwrite a recovery decision and can never trigger a resend.

We do not claim exactly-once SMTP delivery. Ethereal also has no idempotency key, so improving this boundary requires a provider that offers one.

## Rate limits

| Scope | Set by | Enforced by | Notes |
| --- | --- | --- | --- |
| Sender hourly cap | `MAX_EMAILS_PER_HOUR_PER_SENDER` (copied to each sender row when provisioned / on `pnpm seed:ethereal`) | `hourly_usage` row under the sender lock | Protects a sender across all campaigns. |
| Campaign hourly limit | Compose form (`hourlyCap`) | `hourly_usage` row under the campaign lock | Applies to one campaign only. |
| Minimum send gap | `MIN_SEND_DELAY_MS` / sender row | `senders.next_allowed_at` | Measured from the start of each attempt (conservative). |
| Campaign delay | Compose form (`gapSeconds`) | `campaigns.next_allowed_at` | Spacing between a campaign's sends. |

Windows are fixed UTC hours. A burst can therefore send up to `2 × cap` across a boundary; the minimum gap still applies across it. Ordering across parallel workers is best effort, not strict FIFO.

Concurrency: `WORKER_CONCURRENCY` jobs run in parallel, but a sender's in-flight marker permits at most one SMTP transaction per sender at a time. Different senders proceed concurrently.

## Search

Elasticsearch is a derived index. Each state change emits an `EMAIL_INDEX` outbox event. The index worker reads the **latest** database row, never the event payload, and writes with `version_type: external` so stale events receive a 409 and are ignored. Search always applies `workspaceId` and status filters server-side, and it accepts only free text, a view and a cursor. If Elasticsearch is down, `/api/emails/search` returns `503 SEARCH_UNAVAILABLE` while listings and delivery keep working. `pnpm search:reindex` rebuilds the index from PostgreSQL.

## Slack

- OAuth v2 with only the `incoming-webhook` scope. The state is single-use, expires after 10 minutes, and is bound to the user and workspace that started the flow.
- The webhook URL and any retained token are encrypted (AES-256-GCM).
- The notification worker reads the installation at delivery time. It skips a disconnected workspace, re-checks the installation generation just before posting, honours `Retry-After`, retries transient errors, and records permanent failures.
- Disconnect is immediate and local (status, generation, and secrets cleared). The retained token is revoked best-effort with `auth.revoke`. **The incoming webhook itself is not revoked by an API call.** It stays valid until removed in Slack, and the README says so.
- A request already in flight when the user disconnects can finish; this is documented.

## Security

- Google OIDC authorization-code flow with PKCE, state and nonce (`openid-client` v6). Only verified email addresses are accepted. Identity is the Google `sub`.
- Sessions are opaque random tokens; the database stores only an HMAC of the token. Cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` when `SESSION_COOKIE_SECURE=true`.
- CSRF: mutations require a per-session token in `X-CSRF-Token`, and any `Origin` must match the configured web origin.
- Workspace ownership is derived from the session on every query. Browser-supplied workspace IDs are never read.
- Bull Board is mounted at `/admin/queues`, read-only, behind a session and an operator allowlist (`OPERATOR_EMAILS`). Job data contains only IDs.
- Secrets (SMTP credentials, webhook URLs, Slack tokens) are encrypted at rest. Logs redact cookies and never include bodies, recipient lists, or webhook URLs.
