import type { Db } from '@reachinbox/db';
import type { Logger } from '../logger.js';
import { emailJobId, indexJobId, JOB_NAMES, slackJobId, type QueueSet } from '../queue.js';

export interface OutboxRow {
  id: string;
  event_key: string;
  event_type: 'EMAIL_ENQUEUE' | 'EMAIL_INDEX' | 'SLACK_NOTIFY';
  aggregate_id: string;
  payload: { version?: number };
}

/**
 * Leases up to `limit` unpublished rows with SKIP LOCKED so several dispatchers can run safely.
 * The lease expires, so a crashed dispatcher's rows are picked up again. Republication is safe
 * because every BullMQ job ID is derived from the outbox key.
 */
export async function leaseOutboxBatch(
  db: Db,
  opts: { limit: number; leaseMs: number },
): Promise<{ token: string; events: OutboxRow[] }> {
  const token = crypto.randomUUID();
  const r = await db.query<OutboxRow>(
    `WITH picked AS (
       SELECT id FROM outbox_events
        WHERE published_at IS NULL
          AND available_at <= now()
          AND (lease_expires_at IS NULL OR lease_expires_at < now())
        ORDER BY id
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE outbox_events o
        SET lease_token = $2,
            lease_expires_at = now() + make_interval(secs => $3::double precision / 1000),
            attempts = o.attempts + 1
       FROM picked
      WHERE o.id = picked.id
     RETURNING o.id, o.event_key, o.event_type, o.aggregate_id, o.payload`,
    [opts.limit, token, opts.leaseMs],
  );
  const events = r.rows.sort((a, b) => Number(a.id) - Number(b.id));
  return { token, events };
}

export async function markPublished(db: Db, token: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db.query(
    `UPDATE outbox_events
        SET published_at = now(), lease_token = NULL, lease_expires_at = NULL, last_error = NULL
      WHERE lease_token = $1 AND id = ANY($2::bigint[])`,
    [token, ids],
  );
}

export async function releaseFailed(
  db: Db,
  token: string,
  ids: string[],
  error: string,
): Promise<void> {
  if (ids.length === 0) return;
  // Exponential backoff per row based on the attempt count, capped at 30 seconds.
  await db.query(
    `UPDATE outbox_events
        SET lease_token = NULL, lease_expires_at = NULL, last_error = $3,
            available_at = now() + make_interval(secs => LEAST(30, 0.5 * power(2, attempts)))
      WHERE lease_token = $1 AND id = ANY($2::bigint[])`,
    [token, ids, error.slice(0, 500)],
  );
}

/**
 * Publishes leased rows to BullMQ. Email jobs carry only the email ID; the worker re-reads
 * authoritative state. Index jobs carry (emailId, version) pairs; SLACK jobs carry the event ID.
 */
export async function publishBatch(
  db: Db,
  queues: QueueSet,
  logger: Logger,
  batch: { token: string; events: OutboxRow[] },
  now: Date,
): Promise<{ published: number; failed: number }> {
  const enqueue = batch.events.filter((e) => e.event_type === 'EMAIL_ENQUEUE');
  const index = batch.events.filter((e) => e.event_type === 'EMAIL_INDEX');
  const slack = batch.events.filter((e) => e.event_type === 'SLACK_NOTIFY');
  let published = 0;
  let failed = 0;

  if (enqueue.length) {
    const ids = enqueue.map((e) => e.aggregate_id);
    const rows = await db.query<{ id: string; next_attempt_at: Date }>(
      'SELECT id, next_attempt_at FROM emails WHERE id = ANY($1::uuid[])',
      [ids],
    );
    const byId = new Map(rows.rows.map((r) => [r.id, r]));
    const jobs = [];
    for (const e of enqueue) {
      const row = byId.get(e.aggregate_id);
      if (!row) continue; // Deleted with its campaign; nothing to deliver.
      const delay = Math.max(0, new Date(row.next_attempt_at).getTime() - now.getTime());
      jobs.push({
        name: JOB_NAMES.deliverEmail,
        data: { emailId: e.aggregate_id },
        opts: { jobId: emailJobId(e.aggregate_id), delay },
      });
    }
    try {
      if (jobs.length) await queues.email.addBulk(jobs);
      await markPublished(db, batch.token, enqueue.map((e) => e.id));
      published += enqueue.length;
    } catch (error) {
      failed += enqueue.length;
      await releaseFailed(db, batch.token, enqueue.map((e) => e.id), String(error));
      logger.warn({ err: String(error), count: enqueue.length }, 'email enqueue publish failed');
    }
  }

  if (index.length) {
    const items = index.map((e) => ({ emailId: e.aggregate_id, version: Number(e.payload.version ?? 0) }));
    try {
      await queues.index.add(
        JOB_NAMES.indexEmails,
        { items },
        { jobId: indexJobId(items) },
      );
      await markPublished(db, batch.token, index.map((e) => e.id));
      published += index.length;
    } catch (error) {
      failed += index.length;
      await releaseFailed(db, batch.token, index.map((e) => e.id), String(error));
      logger.warn({ err: String(error), count: index.length }, 'index publish failed');
    }
  }

  for (const e of slack) {
    try {
      await queues.notify.add(
        JOB_NAMES.notifySlack,
        { rateLimitEventId: e.aggregate_id },
        { jobId: slackJobId(e.aggregate_id) },
      );
      await markPublished(db, batch.token, [e.id]);
      published += 1;
    } catch (error) {
      failed += 1;
      await releaseFailed(db, batch.token, [e.id], String(error));
      logger.warn({ err: String(error) }, 'slack notify publish failed');
    }
  }
  return { published, failed };
}
