import { withTransaction, type Db } from '@reachinbox/db';
import { insertIndexEvent } from './permit.js';

export type AttemptOutcome = 'ACCEPTED' | 'REJECTED' | 'UNCERTAIN';

export interface SettleInput {
  emailId: string;
  senderId: string;
  attemptToken: string;
  outcome: AttemptOutcome;
  now: Date;
  messageId?: string | null;
  previewUrl?: string | null;
  detail?: string | null;
}

/**
 * Records the outcome of a STARTED attempt. Conditional on status = 'STARTED', so a late
 * settlement can never overwrite what recovery already decided (and never resends).
 */
export async function settleAttempt(db: Db, input: SettleInput): Promise<'SETTLED' | 'ALREADY_RESOLVED'> {
  return withTransaction(db, async (tx) => {
    await tx.query('SELECT id FROM senders WHERE id = $1 FOR UPDATE', [input.senderId]);
    await tx.query('SELECT id FROM emails WHERE id = $1 FOR UPDATE', [input.emailId]);

    const attemptStatus = input.outcome === 'ACCEPTED' ? 'ACCEPTED' : input.outcome === 'REJECTED' ? 'REJECTED' : 'UNCERTAIN';
    const attempt = await tx.query(
      `UPDATE delivery_attempts
          SET status = $2, finished_at = $3, error_class = $4, smtp_response = $5
        WHERE attempt_token = $1 AND status = 'STARTED'
        RETURNING id`,
      [input.attemptToken, attemptStatus, input.now, input.outcome === 'ACCEPTED' ? null : input.outcome, input.detail ?? null],
    );
    // Always release the marker only if it still belongs to this attempt.
    await tx.query(
      `UPDATE senders SET active_attempt_token = NULL, active_attempt_expires_at = NULL
        WHERE id = $1 AND active_attempt_token = $2`,
      [input.senderId, input.attemptToken],
    );
    if (!attempt.rowCount) {
      // Recovery already resolved this attempt. Keep the decision, but preserve any evidence.
      if (input.outcome === 'ACCEPTED' && input.messageId) {
        await tx.query(
          `UPDATE emails SET message_id = $2, preview_url = $3
            WHERE id = $1 AND status = 'DELIVERY_UNCERTAIN' AND message_id IS NULL`,
          [input.emailId, input.messageId, input.previewUrl ?? null],
        );
      }
      return 'ALREADY_RESOLVED' as const;
    }

    let updated;
    if (input.outcome === 'ACCEPTED') {
      updated = await tx.query<{ version: string }>(
        `UPDATE emails
            SET status = 'SENT', sent_at = $2, message_id = $3, preview_url = $4,
                last_error = NULL, version = version + 1, updated_at = $2
          WHERE id = $1 AND status = 'SENDING'
          RETURNING version`,
        [input.emailId, input.now, input.messageId ?? null, input.previewUrl ?? null],
      );
    } else if (input.outcome === 'REJECTED') {
      updated = await tx.query<{ version: string }>(
        `UPDATE emails
            SET status = 'FAILED', last_error = $2, version = version + 1, updated_at = $3
          WHERE id = $1 AND status = 'SENDING'
          RETURNING version`,
        [input.emailId, input.detail ?? 'SMTP rejected', input.now],
      );
    } else {
      updated = await tx.query<{ version: string }>(
        `UPDATE emails
            SET status = 'DELIVERY_UNCERTAIN', last_error = $2, version = version + 1, updated_at = $3
          WHERE id = $1 AND status = 'SENDING'
          RETURNING version`,
        [input.emailId, input.detail ?? 'Delivery outcome unknown', input.now],
      );
    }
    if (updated.rowCount) {
      await insertIndexEvent(tx, input.emailId, Number(updated.rows[0]!.version));
    }
    return 'SETTLED' as const;
  });
}
