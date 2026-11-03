-- ReachInbox schema v1.
-- Authoritative business state lives here. Redis/BullMQ and Elasticsearch are derived/transport layers.
-- All timestamps are timestamptz (UTC instants). Hourly windows are UTC hour truncations.

-- ---------------------------------------------------------------------------
-- Identity and sessions
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_sub   text NOT NULL UNIQUE,
  email        text NOT NULL,
  name         text,
  picture_url  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- One user-owned workspace per Google account for this assignment.
CREATE TABLE workspaces (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id  uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  name           text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Server-side sessions. Only an HMAC of the cookie token is stored.
CREATE TABLE sessions (
  token_hash  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- Short-lived OAuth state (Google login PKCE/nonce, Slack installation bound to a user/workspace).
CREATE TABLE oauth_states (
  state_hash  text PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('google', 'slack')),
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at  timestamptz NOT NULL
);
CREATE INDEX oauth_states_expires_idx ON oauth_states (expires_at);

-- ---------------------------------------------------------------------------
-- Senders
-- ---------------------------------------------------------------------------
-- Pool of provisioned Ethereal accounts (encrypted SMTP config). Copied into each workspace.
CREATE TABLE sender_pool (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label                     text NOT NULL UNIQUE,
  from_address              text NOT NULL,
  smtp_config_encrypted     text NOT NULL,
  created_at                timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE senders (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id              uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  label                     text NOT NULL,
  from_address              text NOT NULL,
  smtp_config_encrypted     text NOT NULL,
  -- Protective caps shared by every campaign that uses this sender.
  hourly_cap                integer NOT NULL CHECK (hourly_cap >= 1),
  min_gap_ms                integer NOT NULL CHECK (min_gap_ms >= 0),
  -- Pacing state and the single in-flight SMTP attempt marker.
  next_allowed_at           timestamptz NOT NULL DEFAULT to_timestamp(0),
  active_attempt_token      uuid,
  active_attempt_expires_at timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, label),
  CHECK ((active_attempt_token IS NULL) = (active_attempt_expires_at IS NULL))
);

-- ---------------------------------------------------------------------------
-- Campaigns and emails
-- ---------------------------------------------------------------------------
CREATE TABLE campaigns (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sender_id         uuid NOT NULL REFERENCES senders(id),
  subject           text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 300),
  body              text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 100000),
  start_at          timestamptz NOT NULL,
  gap_ms            integer NOT NULL CHECK (gap_ms >= 0),
  hourly_cap        integer NOT NULL CHECK (hourly_cap >= 1),
  next_allowed_at   timestamptz NOT NULL DEFAULT to_timestamp(0),
  idempotency_key   text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  payload_hash      text NOT NULL,
  recipient_count   integer NOT NULL CHECK (recipient_count >= 1),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, idempotency_key)
);

-- SCHEDULED -> SENDING -> SENT | FAILED | DELIVERY_UNCERTAIN
--   SCHEDULED/DEFERRED -> DEFERRED (throttled, not an SMTP attempt) -> SENDING
--   SENDING with a stale attempt is moved to DELIVERY_UNCERTAIN by recovery (never resent).
CREATE TABLE emails (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id      uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  workspace_id     uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sender_id        uuid NOT NULL REFERENCES senders(id),
  recipient        text NOT NULL CHECK (char_length(recipient) BETWEEN 3 AND 320),
  sequence         integer NOT NULL CHECK (sequence >= 0),
  scheduled_at     timestamptz NOT NULL,
  next_attempt_at  timestamptz NOT NULL,
  status           text NOT NULL CHECK (status IN (
                     'SCHEDULED', 'DEFERRED', 'SENDING', 'SENT', 'FAILED', 'DELIVERY_UNCERTAIN')),
  deferral_reason  text,
  sent_at          timestamptz,
  message_id       text,
  preview_url      text,
  last_error       text,
  version          bigint NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, recipient),
  UNIQUE (campaign_id, sequence),
  CHECK ((status = 'SENT') = (sent_at IS NOT NULL))
);
CREATE INDEX emails_ws_status_scheduled_idx ON emails (workspace_id, status, scheduled_at, id);
CREATE INDEX emails_ws_sent_idx ON emails (workspace_id, sent_at DESC, id) WHERE sent_at IS NOT NULL;
CREATE INDEX emails_status_id_idx ON emails (status, id);
CREATE INDEX emails_sender_idx ON emails (sender_id, status);

-- At most ONE real SMTP attempt per email (unique email_id). Stale/ambiguous attempts become UNCERTAIN.
CREATE TABLE delivery_attempts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_id        uuid NOT NULL UNIQUE REFERENCES emails(id) ON DELETE CASCADE,
  sender_id       uuid NOT NULL REFERENCES senders(id),
  attempt_token   uuid NOT NULL UNIQUE,
  status          text NOT NULL CHECK (status IN ('STARTED', 'ACCEPTED', 'REJECTED', 'UNCERTAIN')),
  started_at      timestamptz NOT NULL,
  deadline_at     timestamptz NOT NULL,
  finished_at     timestamptz,
  error_class     text,
  smtp_response   text,
  CHECK ((status = 'STARTED') = (finished_at IS NULL))
);
CREATE INDEX delivery_attempts_started_idx ON delivery_attempts (deadline_at) WHERE status = 'STARTED';

-- ---------------------------------------------------------------------------
-- Fixed UTC-hour counters (updated only while holding sender/campaign row locks)
-- ---------------------------------------------------------------------------
CREATE TABLE hourly_usage (
  scope_type     text NOT NULL CHECK (scope_type IN ('SENDER', 'CAMPAIGN')),
  scope_id       uuid NOT NULL,
  hour           timestamptz NOT NULL,
  attempt_count  integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  PRIMARY KEY (scope_type, scope_id, hour)
);

-- Exactly one threshold event per scope and UTC hour.
CREATE TABLE rate_limit_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope_type           text NOT NULL CHECK (scope_type IN ('SENDER', 'CAMPAIGN')),
  scope_id             uuid NOT NULL,
  sender_id            uuid NOT NULL REFERENCES senders(id),
  campaign_id          uuid REFERENCES campaigns(id) ON DELETE CASCADE,
  hour                 timestamptz NOT NULL,
  cap                  integer NOT NULL,
  reached_at           timestamptz NOT NULL,
  next_window_at       timestamptz NOT NULL,
  slack_status         text NOT NULL CHECK (slack_status IN (
                         'PENDING', 'SENT', 'FAILED', 'SKIPPED_NOT_CONNECTED', 'SKIPPED_DISCONNECTED')),
  slack_http_status    integer,
  slack_attempted_at   timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope_type, scope_id, hour)
);
CREATE INDEX rate_limit_events_ws_idx ON rate_limit_events (workspace_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Slack installation (one per workspace)
-- ---------------------------------------------------------------------------
CREATE TABLE slack_installations (
  workspace_id            uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  status                  text NOT NULL CHECK (status IN ('CONNECTED', 'DISCONNECTED')),
  generation              integer NOT NULL DEFAULT 1,
  team_id                 text,
  team_name               text,
  channel_id              text,
  channel_name           text,
  webhook_url_encrypted   text,
  access_token_encrypted  text,
  connected_at            timestamptz,
  disconnected_at         timestamptz,
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Transactional outbox: every queue publication is recorded in the same transaction as its cause.
-- Unique event_key makes event creation idempotent; BullMQ job IDs are derived from the same keys.
-- ---------------------------------------------------------------------------
CREATE TABLE outbox_events (
  id               bigserial PRIMARY KEY,
  event_key        text NOT NULL UNIQUE,
  event_type       text NOT NULL CHECK (event_type IN ('EMAIL_ENQUEUE', 'EMAIL_INDEX', 'SLACK_NOTIFY')),
  aggregate_id     uuid NOT NULL,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  available_at     timestamptz NOT NULL DEFAULT now(),
  lease_token      uuid,
  lease_expires_at timestamptz,
  published_at     timestamptz,
  attempts         integer NOT NULL DEFAULT 0,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_unpublished_idx ON outbox_events (available_at, id) WHERE published_at IS NULL;
CREATE INDEX outbox_type_published_idx ON outbox_events (event_type) WHERE published_at IS NULL;
