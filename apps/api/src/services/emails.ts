import type { Db } from '@reachinbox/db';
import type { EmailRowDto, EmailStatus, EmailView, EmailsPageDto } from '@reachinbox/contracts';
import { SCHEDULED_VIEW_STATUSES, SENT_VIEW_STATUSES } from '@reachinbox/contracts';
import { ApiError } from '../http/errors.js';

interface Cursor {
  t: string;
  id: string;
}

export function encodeListCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeListCursor(raw: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Cursor;
    if (typeof parsed.t !== 'string' || typeof parsed.id !== 'string') throw new Error('shape');
    return parsed;
  } catch {
    throw new ApiError(400, 'INVALID_CURSOR', 'The pagination cursor is invalid');
  }
}

const ROW_SELECT = `
  e.id, e.campaign_id, e.sender_id, s.label AS sender_label, e.recipient, c.subject,
  e.sequence, e.status, e.scheduled_at, e.next_attempt_at, e.sent_at, e.deferral_reason,
  e.last_error, e.preview_url, e.message_id, e.version`;

export function mapEmailRow(r: Record<string, any>): EmailRowDto {
  return {
    id: r.id,
    campaignId: r.campaign_id,
    senderId: r.sender_id,
    senderLabel: r.sender_label,
    recipient: r.recipient,
    subject: r.subject,
    sequence: Number(r.sequence),
    status: r.status as EmailStatus,
    scheduledAt: new Date(r.scheduled_at).toISOString(),
    nextAttemptAt: r.next_attempt_at ? new Date(r.next_attempt_at).toISOString() : null,
    sentAt: r.sent_at ? new Date(r.sent_at).toISOString() : null,
    deferralReason: r.deferral_reason ?? null,
    lastError: r.last_error ?? null,
    previewUrl: r.preview_url ?? null,
    messageId: r.message_id ?? null,
    version: Number(r.version),
  };
}

/**
 * Database-backed listing (ordinary tables). Keyset pagination on a stable (sort key, id) pair.
 * The workspace is the authenticated one; no client-supplied workspace is ever read.
 */
export async function listEmails(
  db: Db,
  p: { workspaceId: string; view: EmailView; limit: number; cursor?: string | undefined; senderId?: string | undefined },
): Promise<EmailsPageDto> {
  const statuses = p.view === 'scheduled' ? SCHEDULED_VIEW_STATUSES : SENT_VIEW_STATUSES;
  const params: unknown[] = [p.workspaceId, [...statuses]];
  let where = 'e.workspace_id = $1 AND e.status = ANY($2::text[])';
  if (p.senderId) {
    params.push(p.senderId);
    where += ` AND e.sender_id = $${params.length}`;
  }
  const sortExpr = p.view === 'scheduled' ? 'e.scheduled_at' : 'COALESCE(e.sent_at, e.scheduled_at)';
  const order = p.view === 'scheduled' ? 'ASC' : 'DESC';
  if (p.cursor) {
    const c = decodeListCursor(p.cursor);
    params.push(c.t, c.id);
    const op = p.view === 'scheduled' ? '>' : '<';
    where += ` AND (${sortExpr}, e.id) ${op} ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  params.push(p.limit + 1);
  const r = await db.query(
    `SELECT ${ROW_SELECT}, ${sortExpr} AS sort_at
       FROM emails e
       JOIN campaigns c ON c.id = e.campaign_id
       JOIN senders s ON s.id = e.sender_id
      WHERE ${where}
      ORDER BY ${sortExpr} ${order}, e.id ${order}
      LIMIT $${params.length}`,
    params,
  );
  const hasMore = r.rows.length > p.limit;
  const page = r.rows.slice(0, p.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(mapEmailRow),
    nextCursor: hasMore && last ? encodeListCursor({ t: new Date(last.sort_at).toISOString(), id: last.id }) : null,
  };
}

export async function getEmailDetail(db: Db, workspaceId: string, emailId: string) {
  const r = await db.query(
    `SELECT ${ROW_SELECT}, d.status AS attempt_status, d.started_at AS attempt_started_at,
            d.finished_at AS attempt_finished_at, d.error_class
       FROM emails e
       JOIN campaigns c ON c.id = e.campaign_id
       JOIN senders s ON s.id = e.sender_id
       LEFT JOIN delivery_attempts d ON d.email_id = e.id
      WHERE e.id = $1 AND e.workspace_id = $2`,
    [emailId, workspaceId],
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    ...mapEmailRow(row),
    attempt: row.attempt_status
      ? {
          status: row.attempt_status,
          startedAt: new Date(row.attempt_started_at).toISOString(),
          finishedAt: row.attempt_finished_at ? new Date(row.attempt_finished_at).toISOString() : null,
          errorClass: row.error_class ?? null,
        }
      : null,
  };
}
