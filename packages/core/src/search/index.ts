import { Client } from '@elastic/elasticsearch';
import type { Db } from '@reachinbox/db';
import { SCHEDULED_VIEW_STATUSES, SENT_VIEW_STATUSES, type EmailView, type SearchHitDto } from '@reachinbox/contracts';

export function createEsClient(url: string): Client {
  return new Client({ node: url, requestTimeout: 15_000, maxRetries: 2 });
}

export const INDEX_MAPPINGS = {
  settings: { number_of_shards: 1, number_of_replicas: 0 },
  mappings: {
    dynamic: 'strict' as const,
    properties: {
      emailId: { type: 'keyword' as const },
      workspaceId: { type: 'keyword' as const },
      campaignId: { type: 'keyword' as const },
      senderId: { type: 'keyword' as const },
      senderLabel: { type: 'keyword' as const },
      sequence: { type: 'integer' as const },
      recipient: { type: 'text' as const, fields: { raw: { type: 'keyword' as const } } },
      subject: { type: 'text' as const, fields: { raw: { type: 'keyword' as const } } },
      body: { type: 'text' as const },
      status: { type: 'keyword' as const },
      scheduledAt: { type: 'date' as const },
      sentAt: { type: 'date' as const },
      version: { type: 'long' as const },
    },
  },
};

/** Creates the index with explicit mappings if it is missing. Mapping changes need a new index name + reindex. */
export async function ensureIndex(client: Client, index: string): Promise<boolean> {
  const exists = await client.indices.exists({ index });
  if (exists) return false;
  try {
    await client.indices.create({ index, ...INDEX_MAPPINGS });
    return true;
  } catch (error) {
    // Another process created it concurrently.
    if ((error as { meta?: { body?: { error?: { type?: string } } } }).meta?.body?.error?.type === 'resource_already_exists_exception') {
      return false;
    }
    throw error;
  }
}

export interface IndexDocument {
  emailId: string;
  workspaceId: string;
  campaignId: string;
  senderId: string;
  senderLabel: string;
  sequence: number;
  recipient: string;
  subject: string;
  body: string;
  status: string;
  scheduledAt: string;
  sentAt: string | null;
  version: number;
}

/**
 * Bulk upsert with external versioning: ES rejects a write whose version is not greater than the
 * stored one (409). That makes out-of-order or replayed events harmless.
 */
export async function bulkIndexDocuments(
  client: Client,
  index: string,
  docs: IndexDocument[],
): Promise<{ indexed: number; ignoredStale: number; failed: number }> {
  if (docs.length === 0) return { indexed: 0, ignoredStale: 0, failed: 0 };
  const operations: Array<Record<string, unknown>> = [];
  for (const doc of docs) {
    operations.push({
      index: { _index: index, _id: doc.emailId, version: doc.version, version_type: 'external' },
    });
    const { emailId: _ignored, ...rest } = doc;
    operations.push({ emailId: doc.emailId, ...rest });
  }
  const response = await client.bulk({ operations, refresh: false });
  let indexed = 0;
  let ignoredStale = 0;
  let failed = 0;
  for (const item of response.items) {
    const result = Object.values(item)[0];
    if (!result) continue;
    if (result.error) {
      if (result.status === 409) ignoredStale += 1;
      else failed += 1;
    } else {
      indexed += 1;
    }
  }
  return { indexed, ignoredStale, failed };
}

export interface SearchParams {
  workspaceId: string;
  view: EmailView;
  q: string;
  limit: number;
  cursor: string | null;
  index: string;
}

export function encodeCursor(sort: unknown[]): string {
  return Buffer.from(JSON.stringify(sort), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): unknown[] {
  const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  if (!Array.isArray(parsed)) throw new Error('Invalid cursor');
  return parsed;
}

/**
 * Search is built entirely server-side. The client supplies only free text, a view and a cursor;
 * the workspace filter is always applied here, never taken from the request.
 */
export async function searchEmails(
  client: Client,
  params: SearchParams,
): Promise<{ items: SearchHitDto[]; nextCursor: string | null }> {
  const statuses = params.view === 'scheduled' ? SCHEDULED_VIEW_STATUSES : SENT_VIEW_STATUSES;
  const sort: Array<Record<string, unknown>> =
    params.view === 'sent'
      ? [{ sentAt: { order: 'desc', missing: '_last' } }, { emailId: { order: 'asc' } }]
      : [{ scheduledAt: { order: 'asc' } }, { emailId: { order: 'asc' } }];

  const response = await client.search<IndexDocument>({
    index: params.index,
    size: params.limit,
    track_total_hits: false,
    query: {
      bool: {
        filter: [{ term: { workspaceId: params.workspaceId } }, { terms: { status: [...statuses] } }],
        must: [
          {
            multi_match: {
              query: params.q,
              fields: ['subject^3', 'recipient^2', 'body'],
              type: 'best_fields',
              operator: 'and',
            },
          },
        ],
      },
    },
    sort: sort as never,
    ...(params.cursor ? { search_after: decodeCursor(params.cursor) as never } : {}),
  });

  const hits = response.hits.hits;
  const items: SearchHitDto[] = hits.map((hit) => {
    const s = hit._source!;
    return {
      id: s.emailId,
      campaignId: s.campaignId,
      senderId: s.senderId,
      senderLabel: s.senderLabel,
      recipient: s.recipient,
      subject: s.subject,
      sequence: s.sequence,
      status: s.status as SearchHitDto['status'],
      scheduledAt: s.scheduledAt,
      nextAttemptAt: null,
      sentAt: s.sentAt,
      deferralReason: null,
      lastError: null,
      previewUrl: null,
      messageId: null,
      version: s.version,
      score: hit._score ?? null,
    };
  });
  const last = hits[hits.length - 1];
  const nextCursor = hits.length === params.limit && last?.sort ? encodeCursor(last.sort as unknown[]) : null;
  return { items, nextCursor };
}

/** Authoritative rows for indexing: always the latest DB state, never the event payload. */
export async function loadIndexDocuments(db: Db, emailIds: string[]): Promise<IndexDocument[]> {
  if (emailIds.length === 0) return [];
  const r = await db.query(
    `SELECT e.id, e.workspace_id, e.campaign_id, e.sender_id, s.label AS sender_label, e.sequence,
            e.recipient, c.subject, c.body, e.status, e.scheduled_at, e.sent_at, e.version
       FROM emails e
       JOIN campaigns c ON c.id = e.campaign_id
       JOIN senders s ON s.id = e.sender_id
      WHERE e.id = ANY($1::uuid[])`,
    [emailIds],
  );
  return r.rows.map((row) => ({
    emailId: row.id,
    workspaceId: row.workspace_id,
    campaignId: row.campaign_id,
    senderId: row.sender_id,
    senderLabel: row.sender_label,
    sequence: row.sequence,
    recipient: row.recipient,
    subject: row.subject,
    body: row.body,
    status: row.status,
    scheduledAt: new Date(row.scheduled_at).toISOString(),
    sentAt: row.sent_at ? new Date(row.sent_at).toISOString() : null,
    version: Number(row.version),
  }));
}

/** Rebuilds the whole index from PostgreSQL in keyset-paginated batches. Safe to run repeatedly. */
export async function reindexAll(
  db: Db,
  client: Client,
  index: string,
  batchSize = 500,
  onProgress?: (n: number) => void,
): Promise<number> {
  await ensureIndex(client, index);
  let cursor = '00000000-0000-0000-0000-000000000000';
  let total = 0;
  for (;;) {
    const page = await db.query<{ id: string }>(
      'SELECT id FROM emails WHERE id > $1 ORDER BY id LIMIT $2',
      [cursor, batchSize],
    );
    if (page.rows.length === 0) break;
    cursor = page.rows[page.rows.length - 1]!.id;
    const docs = await loadIndexDocuments(db, page.rows.map((r) => r.id));
    const result = await bulkIndexDocuments(client, index, docs);
    if (result.failed > 0) throw new Error(`Reindex failed for ${result.failed} documents`);
    total += docs.length;
    onProgress?.(total);
  }
  await client.indices.refresh({ index }).catch(() => undefined);
  return total;
}
