import type { Db, Tx } from '@reachinbox/db';
import { withTransaction, isUniqueViolation } from '@reachinbox/db';
import { analyzeRecipients, type CampaignCreatedDto, type CampaignProgressDto, type CreateCampaignBody, type EmailStatus, EMAIL_STATUSES } from '@reachinbox/contracts';
import { sha256Hex, type Config } from '@reachinbox/core';
import { ApiError } from '../http/errors.js';

const INSERT_CHUNK = 2000;

/**
 * Persists one campaign, one email per unique recipient and the outbox intents for enqueueing and
 * indexing, all in a single transaction. Returns only after COMMIT; queue publication happens later.
 */
export async function createCampaign(
  db: Db,
  config: Config,
  ctx: { workspaceId: string },
  idempotencyKey: string,
  body: CreateCampaignBody,
): Promise<CampaignCreatedDto> {
  const report = analyzeRecipients(body.recipients);
  if (report.invalid > 0) {
    throw new ApiError(422, 'INVALID_RECIPIENTS', `${report.invalid} recipient(s) are not valid email addresses`, {
      valid: report.valid,
      invalid: report.invalid,
      duplicates: report.duplicates,
    });
  }
  if (report.unique.length === 0) {
    throw new ApiError(422, 'NO_VALID_RECIPIENTS', 'No valid recipients were provided');
  }
  if (report.unique.length > config.limits.maxRecipientsPerCampaign) {
    throw new ApiError(422, 'TOO_MANY_RECIPIENTS', `A campaign may contain at most ${config.limits.maxRecipientsPerCampaign} recipients`, {
      max: config.limits.maxRecipientsPerCampaign,
      actual: report.unique.length,
    });
  }

  const startAt = new Date(body.startAt);
  const gapMs = body.gapSeconds * 1000;
  const payloadHash = sha256Hex(
    JSON.stringify({
      senderId: body.senderId,
      subject: body.subject,
      body: body.body,
      startAt: startAt.toISOString(),
      gapSeconds: body.gapSeconds,
      hourlyCap: body.hourlyCap,
      recipients: report.unique,
    }),
  );

  return withTransaction(db, async (tx) => {
    const sender = (
      await tx.query<{ id: string }>('SELECT id FROM senders WHERE id = $1 AND workspace_id = $2', [
        body.senderId,
        ctx.workspaceId,
      ])
    ).rows[0];
    if (!sender) throw new ApiError(404, 'SENDER_NOT_FOUND', 'Sender not found');

    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO campaigns
         (workspace_id, sender_id, subject, body, start_at, gap_ms, hourly_cap,
          idempotency_key, payload_hash, recipient_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [
        ctx.workspaceId,
        body.senderId,
        body.subject,
        body.body,
        startAt,
        gapMs,
        body.hourlyCap,
        idempotencyKey,
        payloadHash,
        report.unique.length,
      ],
    );

    if (!inserted.rows[0]) {
      // Same key already exists (possibly inserted concurrently and now committed).
      const existing = (
        await tx.query<{ id: string; payload_hash: string }>(
          'SELECT id, payload_hash FROM campaigns WHERE workspace_id = $1 AND idempotency_key = $2',
          [ctx.workspaceId, idempotencyKey],
        )
      ).rows[0]!;
      if (existing.payload_hash !== payloadHash) {
        throw new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request');
      }
      return progressDto(tx, existing.id, true);
    }
    const campaignId = inserted.rows[0].id;

    let sequence = 0;
    for (let offset = 0; offset < report.unique.length; offset += INSERT_CHUNK) {
      const slice = report.unique.slice(offset, offset + INSERT_CHUNK);
      const recipients: string[] = [];
      const sequences: number[] = [];
      const due: string[] = [];
      for (const recipient of slice) {
        recipients.push(recipient);
        sequences.push(sequence);
        due.push(new Date(startAt.getTime() + sequence * gapMs).toISOString());
        sequence += 1;
      }
      await tx.query(
        `INSERT INTO emails
           (campaign_id, workspace_id, sender_id, recipient, sequence, scheduled_at, next_attempt_at, status, version)
         SELECT $1, $2, $3, t.recipient, t.seq, t.due, t.due, 'SCHEDULED', 1
           FROM unnest($4::text[], $5::int[], $6::timestamptz[]) AS t(recipient, seq, due)`,
        [campaignId, ctx.workspaceId, body.senderId, recipients, sequences, due],
      );
    }

    // Outbox intents: enqueue each email, and index its initial scheduled state.
    await tx.query(
      `INSERT INTO outbox_events (event_key, event_type, aggregate_id)
       SELECT 'enqueue:' || id::text, 'EMAIL_ENQUEUE', id FROM emails WHERE campaign_id = $1
       ON CONFLICT (event_key) DO NOTHING`,
      [campaignId],
    );
    await tx.query(
      `INSERT INTO outbox_events (event_key, event_type, aggregate_id, payload)
       SELECT 'index:' || id::text || ':1', 'EMAIL_INDEX', id, '{"version": 1}'::jsonb
         FROM emails WHERE campaign_id = $1
       ON CONFLICT (event_key) DO NOTHING`,
      [campaignId],
    );

    return {
      campaignId,
      status: 'ACCEPTED' as const,
      acceptedCount: report.unique.length,
      duplicateCount: report.duplicates,
      replayed: false,
      enqueue: { published: 0, total: report.unique.length },
      links: { campaign: `/api/campaigns/${campaignId}` },
    };
  });
}

export async function getCampaignProgress(db: Db, workspaceId: string, campaignId: string): Promise<CampaignProgressDto | null> {
  const exists = await db.query('SELECT 1 FROM campaigns WHERE id = $1 AND workspace_id = $2', [campaignId, workspaceId]);
  if (!exists.rowCount) return null;
  return progressDto(db, campaignId, false);
}

async function progressDto(q: Db | Tx, campaignId: string, replayed: boolean): Promise<CampaignCreatedDto & CampaignProgressDto> {
  const c = (
    await q.query(
      `SELECT c.id, c.subject, c.sender_id, c.start_at, c.gap_ms, c.hourly_cap, c.recipient_count, c.created_at
         FROM campaigns c WHERE c.id = $1`,
      [campaignId],
    )
  ).rows[0];
  const counts = await countsFor(q, campaignId);
  const enqueue = await enqueueProgress(q, campaignId);
  return {
    id: c.id,
    subject: c.subject,
    senderId: c.sender_id,
    startAt: new Date(c.start_at).toISOString(),
    gapSeconds: Number(c.gap_ms) / 1000,
    hourlyCap: c.hourly_cap,
    recipientCount: c.recipient_count,
    counts,
    enqueue,
    createdAt: new Date(c.created_at).toISOString(),
    campaignId: c.id,
    status: 'ACCEPTED',
    acceptedCount: c.recipient_count,
    duplicateCount: 0,
    replayed,
    links: { campaign: `/api/campaigns/${c.id}` },
  } as CampaignCreatedDto & CampaignProgressDto;
}

async function countsFor(q: Db | Tx, campaignId: string): Promise<Record<EmailStatus, number>> {
  const rows = await q.query<{ status: EmailStatus; n: string }>(
    'SELECT status, count(*)::text AS n FROM emails WHERE campaign_id = $1 GROUP BY status',
    [campaignId],
  );
  const counts = Object.fromEntries(EMAIL_STATUSES.map((s) => [s, 0])) as Record<EmailStatus, number>;
  for (const r of rows.rows) counts[r.status] = Number(r.n);
  return counts;
}

async function enqueueProgress(q: Db | Tx, campaignId: string): Promise<{ published: number; total: number }> {
  const r = await q.query<{ total: string; published: string }>(
    `SELECT count(*)::text AS total,
            count(o.published_at)::text AS published
       FROM emails e
       LEFT JOIN outbox_events o ON o.event_key = 'enqueue:' || e.id::text
      WHERE e.campaign_id = $1`,
    [campaignId],
  );
  return { total: Number(r.rows[0]?.total ?? 0), published: Number(r.rows[0]?.published ?? 0) };
}

export { isUniqueViolation };
