import type { Db } from '@reachinbox/db';
import type { Logger } from '../logger.js';
import { emailJobId, JOB_NAMES, type QueueSet } from '../queue.js';

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Boot-time reconciliation. Pages through emails that are still pending and have never had an
 * SMTP attempt, and rebuilds the BullMQ delayed job for any that have no job. Healthy jobs in any
 * live state are left untouched. Whole campaigns are never regenerated relative to startup time:
 * each job's delay is derived from the stored next_attempt_at.
 */
export async function reconcilePendingJobs(
  db: Db,
  queues: QueueSet,
  logger: Logger,
  opts: { pageSize?: number; now: () => Date },
): Promise<{ scanned: number; republished: number; replacedFailed: number }> {
  const pageSize = opts.pageSize ?? 500;
  let cursor = ZERO_UUID;
  let scanned = 0;
  let republished = 0;
  let replacedFailed = 0;

  for (;;) {
    const page = await db.query<{ id: string; next_attempt_at: Date }>(
      `SELECT e.id, e.next_attempt_at
         FROM emails e
        WHERE e.status IN ('SCHEDULED', 'DEFERRED')
          AND e.id > $1
          AND NOT EXISTS (SELECT 1 FROM delivery_attempts d WHERE d.email_id = e.id)
        ORDER BY e.id
        LIMIT $2`,
      [cursor, pageSize],
    );
    if (page.rows.length === 0) break;
    cursor = page.rows[page.rows.length - 1]!.id;
    scanned += page.rows.length;

    const missing: Array<{ name: string; data: { emailId: string }; opts: { jobId: string; delay: number } }> = [];
    for (const row of page.rows) {
      const jobId = emailJobId(row.id);
      const job = await queues.email.getJob(jobId);
      const delay = Math.max(0, new Date(row.next_attempt_at).getTime() - opts.now().getTime());
      if (!job) {
        missing.push({ name: JOB_NAMES.deliverEmail, data: { emailId: row.id }, opts: { jobId, delay } });
        continue;
      }
      const state = await job.getState();
      if (state === 'failed' || state === 'completed') {
        // A finished job for a row with no attempt cannot have been a genuine SMTP attempt;
        // re-create it so delivery proceeds. Same-ID jobs would otherwise be de-duplicated away.
        await job.remove().catch(() => undefined);
        replacedFailed += 1;
        missing.push({ name: JOB_NAMES.deliverEmail, data: { emailId: row.id }, opts: { jobId, delay } });
      }
    }
    if (missing.length) {
      await queues.email.addBulk(missing);
      republished += missing.length;
    }
  }
  if (republished || replacedFailed) {
    logger.info({ scanned, republished, replacedFailed }, 'queue reconciliation rebuilt jobs');
  }
  return { scanned, republished, replacedFailed };
}
