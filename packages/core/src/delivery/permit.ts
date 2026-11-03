import { randomUUID } from 'node:crypto';
import { withTransaction, type Db, type Tx } from '@reachinbox/db';
import { nextUtcHour, utcHourStart } from '../clock.js';
import type { DeferReason, PermitInput, PermitOutcome, SendPayload } from './types.js';

const TERMINAL = new Set(['SENT', 'FAILED', 'DELIVERY_UNCERTAIN']);

/**
 * Atomically decides whether one email may be sent now.
 *
 * Lock order is always sender -> campaign -> email to avoid deadlocks. No network I/O happens
 * inside this transaction. The transaction either:
 *   - returns SKIP (terminal or already in flight),
 *   - returns DEFER (nothing is consumed; the caller moves the BullMQ job to delayed), or
 *   - records a STARTED attempt, reserves one unit in each hourly counter, sets the sender's
 *     in-flight marker and pacing, and returns SEND.
 */
export async function reservePermit(db: Db, input: PermitInput): Promise<PermitOutcome> {
  const { emailId, now } = input;
  const attemptToken = randomUUID();
  const deadlineAt = new Date(now.getTime() + input.attemptDeadlineMs);

  return withTransaction(db, async (tx) => {
    const ref = await tx.query<{ sender_id: string; campaign_id: string }>(
      'SELECT sender_id, campaign_id FROM emails WHERE id = $1',
      [emailId],
    );
    const refRow = ref.rows[0];
    if (!refRow) return { kind: 'SKIP', reason: 'NOT_FOUND' } as const;

    const sender = (
      await tx.query(`SELECT * FROM senders WHERE id = $1 FOR UPDATE`, [refRow.sender_id])
    ).rows[0];
    const campaign = (
      await tx.query(`SELECT * FROM campaigns WHERE id = $1 FOR UPDATE`, [refRow.campaign_id])
    ).rows[0];
    const email = (await tx.query(`SELECT * FROM emails WHERE id = $1 FOR UPDATE`, [emailId])).rows[0];
    if (!sender || !campaign || !email) return { kind: 'SKIP', reason: 'NOT_FOUND' } as const;

    if (TERMINAL.has(email.status)) {
      return { kind: 'SKIP', reason: 'TERMINAL', status: email.status } as const;
    }
    if (email.status === 'SENDING') {
      return { kind: 'SKIP', reason: 'ALREADY_SENDING', status: email.status } as const;
    }

    const attemptExists = await tx.query('SELECT 1 FROM delivery_attempts WHERE email_id = $1', [emailId]);
    if (attemptExists.rowCount) return { kind: 'SKIP', reason: 'ALREADY_SENDING' } as const;

    const nextAttemptAt = new Date(email.next_attempt_at);
    if (nextAttemptAt > now) {
      return { kind: 'DEFER', reason: 'NOT_YET_DUE', nextAt: nextAttemptAt } as const;
    }

    // In-flight marker: at most one SMTP operation per sender at a time.
    if (sender.active_attempt_token) {
      return defer(tx, email, 'SENDER_IN_FLIGHT', new Date(now.getTime() + 1000), now);
    }
    const senderNext = new Date(sender.next_allowed_at);
    if (senderNext > now) return defer(tx, email, 'SENDER_PACING', senderNext, now);
    const campaignNext = new Date(campaign.next_allowed_at);
    if (campaignNext > now) return defer(tx, email, 'CAMPAIGN_PACING', campaignNext, now);

    const hour = utcHourStart(now);
    const senderUsed = await readUsage(tx, 'SENDER', sender.id, hour);
    if (senderUsed >= sender.hourly_cap) {
      return defer(tx, email, 'SENDER_HOURLY_CAP', nextUtcHour(now), now);
    }
    const campaignUsed = await readUsage(tx, 'CAMPAIGN', campaign.id, hour);
    if (campaignUsed >= campaign.hourly_cap) {
      return defer(tx, email, 'CAMPAIGN_HOURLY_CAP', nextUtcHour(now), now);
    }

    // ---- Permit granted: all writes below commit together or not at all. ----
    await tx.query(
      `INSERT INTO delivery_attempts (email_id, sender_id, attempt_token, status, started_at, deadline_at)
       VALUES ($1, $2, $3, 'STARTED', $4, $5)`,
      [emailId, sender.id, attemptToken, now, deadlineAt],
    );

    const senderCount = await incrementUsage(tx, 'SENDER', sender.id, hour);
    const campaignCount = await incrementUsage(tx, 'CAMPAIGN', campaign.id, hour);

    const slack = await tx.query<{ status: string }>(
      'SELECT status FROM slack_installations WHERE workspace_id = $1',
      [sender.workspace_id],
    );
    const slackConnected = slack.rows[0]?.status === 'CONNECTED';

    if (senderCount >= sender.hourly_cap) {
      await recordThreshold(tx, {
        scope: 'SENDER',
        scopeId: sender.id,
        workspaceId: sender.workspace_id,
        senderId: sender.id,
        campaignId: null,
        hour,
        cap: sender.hourly_cap,
        now,
        slackConnected,
      });
    }
    if (campaignCount >= campaign.hourly_cap) {
      await recordThreshold(tx, {
        scope: 'CAMPAIGN',
        scopeId: campaign.id,
        workspaceId: sender.workspace_id,
        senderId: sender.id,
        campaignId: campaign.id,
        hour,
        cap: campaign.hourly_cap,
        now,
        slackConnected,
      });
    }

    await tx.query(
      `UPDATE senders
          SET next_allowed_at = $2,
              active_attempt_token = $3,
              active_attempt_expires_at = $4
        WHERE id = $1`,
      [
        sender.id,
        new Date(now.getTime() + Number(sender.min_gap_ms)),
        attemptToken,
        new Date(deadlineAt.getTime() + input.attemptGraceMs),
      ],
    );
    await tx.query('UPDATE campaigns SET next_allowed_at = $2 WHERE id = $1', [
      campaign.id,
      new Date(now.getTime() + Number(campaign.gap_ms)),
    ]);
    const updated = await tx.query<{ version: string }>(
      `UPDATE emails
          SET status = 'SENDING', deferral_reason = NULL, next_attempt_at = $2,
              version = version + 1, updated_at = $2
        WHERE id = $1
        RETURNING version`,
      [emailId, now],
    );
    await insertIndexEvent(tx, emailId, Number(updated.rows[0]?.version));

    const payload: SendPayload = {
      emailId,
      workspaceId: sender.workspace_id,
      campaignId: campaign.id,
      senderId: sender.id,
      senderLabel: sender.label,
      fromAddress: sender.from_address,
      smtpConfigEncrypted: sender.smtp_config_encrypted,
      recipient: email.recipient,
      subject: campaign.subject,
      body: campaign.body,
    };
    return { kind: 'SEND', attemptToken, deadlineAt, payload } as const;
  });
}

async function defer(
  tx: Tx,
  email: { id: string; status: string; deferral_reason: string | null },
  reason: DeferReason,
  nextAt: Date,
  now: Date,
): Promise<PermitOutcome> {
  // Status/reason changes are versioned and indexed; pure re-checks only move the timer.
  if (email.status !== 'DEFERRED' || email.deferral_reason !== reason) {
    const updated = await tx.query<{ version: string }>(
      `UPDATE emails
          SET status = 'DEFERRED', deferral_reason = $2, next_attempt_at = $3,
              version = version + 1, updated_at = $4
        WHERE id = $1
        RETURNING version`,
      [email.id, reason, nextAt, now],
    );
    await insertIndexEvent(tx, email.id, Number(updated.rows[0]?.version));
  } else {
    await tx.query('UPDATE emails SET next_attempt_at = $2 WHERE id = $1', [email.id, nextAt]);
  }
  return { kind: 'DEFER', reason, nextAt };
}

async function readUsage(
  tx: Tx,
  scope: 'SENDER' | 'CAMPAIGN',
  scopeId: string,
  hour: Date,
): Promise<number> {
  const r = await tx.query<{ attempt_count: number }>(
    'SELECT attempt_count FROM hourly_usage WHERE scope_type = $1 AND scope_id = $2 AND hour = $3',
    [scope, scopeId, hour],
  );
  return r.rows[0]?.attempt_count ?? 0;
}

async function incrementUsage(
  tx: Tx,
  scope: 'SENDER' | 'CAMPAIGN',
  scopeId: string,
  hour: Date,
): Promise<number> {
  const r = await tx.query<{ attempt_count: number }>(
    `INSERT INTO hourly_usage (scope_type, scope_id, hour, attempt_count)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (scope_type, scope_id, hour)
     DO UPDATE SET attempt_count = hourly_usage.attempt_count + 1
     RETURNING attempt_count`,
    [scope, scopeId, hour],
  );
  return r.rows[0]!.attempt_count;
}

/**
 * Inserts the threshold event exactly once per (scope, hour). When it is inserted for a connected
 * Slack installation, the notification is queued through the same outbox transaction.
 */
async function recordThreshold(
  tx: Tx,
  p: {
    scope: 'SENDER' | 'CAMPAIGN';
    scopeId: string;
    workspaceId: string;
    senderId: string;
    campaignId: string | null;
    hour: Date;
    cap: number;
    now: Date;
    slackConnected: boolean;
  },
): Promise<void> {
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO rate_limit_events
       (workspace_id, scope_type, scope_id, sender_id, campaign_id, hour, cap,
        reached_at, next_window_at, slack_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (scope_type, scope_id, hour) DO NOTHING
     RETURNING id`,
    [
      p.workspaceId,
      p.scope,
      p.scopeId,
      p.senderId,
      p.campaignId,
      p.hour,
      p.cap,
      p.now,
      nextUtcHour(p.now),
      p.slackConnected ? 'PENDING' : 'SKIPPED_NOT_CONNECTED',
    ],
  );
  const eventId = inserted.rows[0]?.id;
  if (eventId && p.slackConnected) {
    await tx.query(
      `INSERT INTO outbox_events (event_key, event_type, aggregate_id)
       VALUES ($1, 'SLACK_NOTIFY', $2)
       ON CONFLICT (event_key) DO NOTHING`,
      [`slack:${eventId}`, eventId],
    );
  }
}

export async function insertIndexEvent(tx: Tx, emailId: string, version: number): Promise<void> {
  await tx.query(
    `INSERT INTO outbox_events (event_key, event_type, aggregate_id, payload)
     VALUES ($1, 'EMAIL_INDEX', $2, jsonb_build_object('version', $3::bigint))
     ON CONFLICT (event_key) DO NOTHING`,
    [`index:${emailId}:${version}`, emailId, version],
  );
}
