import type { Db } from '@reachinbox/db';
import { settleAttempt } from './settle.js';

/**
 * Resolves STARTED attempts whose deadline has passed. These are ambiguous by definition: the
 * process may have died before, during or after the SMTP transaction. They become
 * DELIVERY_UNCERTAIN and are never resubmitted automatically.
 */
export async function recoverStaleAttempts(db: Db, now: Date, limit = 200): Promise<number> {
  const stale = await db.query<{
    email_id: string;
    sender_id: string;
    attempt_token: string;
  }>(
    `SELECT email_id, sender_id, attempt_token
       FROM delivery_attempts
      WHERE status = 'STARTED' AND deadline_at < $1
      ORDER BY deadline_at
      LIMIT $2`,
    [now, limit],
  );
  let resolved = 0;
  for (const row of stale.rows) {
    const result = await settleAttempt(db, {
      emailId: row.email_id,
      senderId: row.sender_id,
      attemptToken: row.attempt_token,
      outcome: 'UNCERTAIN',
      now,
      detail: 'Stale attempt after process failure; SMTP outcome unknown and not resent',
    });
    if (result === 'SETTLED') resolved += 1;
  }
  return resolved;
}

/** Clears in-flight markers whose attempt no longer exists or is no longer STARTED. */
export async function clearOrphanSenderMarkers(db: Db, now: Date): Promise<number> {
  const r = await db.query(
    `UPDATE senders s
        SET active_attempt_token = NULL, active_attempt_expires_at = NULL
      WHERE s.active_attempt_token IS NOT NULL
        AND s.active_attempt_expires_at < $1
        AND NOT EXISTS (
          SELECT 1 FROM delivery_attempts d
           WHERE d.attempt_token = s.active_attempt_token AND d.status = 'STARTED')`,
    [now],
  );
  return r.rowCount ?? 0;
}
