import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createLogger, leaseOutboxBatch, publishBatch, systemClock, emailJobId } from '@reachinbox/core';
import { createCampaign } from '../../apps/api/src/services/campaigns.js';
import { createRuntime, resetState, seedUser, seedSender, type Runtime, type Seeded } from '../fixtures/harness.js';
import { startSink, type Sink } from '../fixtures/smtp-sink.js';

let rt: Runtime;
let sink: Sink;
let owner: Seeded;
let other: Seeded;
let ownerSender: string;
const logger = createLogger('test-pipeline', 'error');

async function drain(): Promise<void> {
  for (;;) {
    const batch = await leaseOutboxBatch(rt.db, { limit: 200, leaseMs: 30_000 });
    if (batch.events.length === 0) return;
    await publishBatch(rt.db, rt.queues, logger, batch, systemClock.now());
  }
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 25_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 200));
  }
}

beforeAll(async () => {
  sink = await startSink();
});
afterAll(async () => {
  await sink.close();
  await rt?.close();
});
beforeEach(async () => {
  rt = await createRuntime({ startWorkers: true });
  await resetState(rt);
  sink.reset();
  owner = await seedUser(rt.db, rt.config, 'pipeline-owner@test.local');
  other = await seedUser(rt.db, rt.config, 'pipeline-other@test.local');
  ownerSender = await seedSender(rt.db, rt.config, owner.workspaceId, { port: sink.port, label: 'Pipeline sender' });
  await seedSender(rt.db, rt.config, other.workspaceId, { port: sink.port, label: 'Other sender' });
});

describe('end-to-end: outbox -> BullMQ workers -> SMTP -> Elasticsearch', () => {
  it('delivers due emails exactly once, indexes them, and searches only within the owning workspace', async () => {
    const dueSoon = await createCampaign(rt.db, rt.config, { workspaceId: owner.workspaceId }, 'pipeline-due-1', {
      senderId: ownerSender,
      subject: 'Zephyr quarterly digest',
      body: 'Plain body text for search',
      startAt: new Date(Date.now() + 1500).toISOString(),
      gapSeconds: 0,
      hourlyCap: 100,
      recipients: ['p1@x.com', 'p2@x.com', 'p3@x.com'],
    });
    const future = await createCampaign(rt.db, rt.config, { workspaceId: owner.workspaceId }, 'pipeline-future-1', {
      senderId: ownerSender,
      subject: 'Zephyr later announcement',
      body: 'Scheduled for later',
      startAt: new Date(Date.now() + 3_600_000).toISOString(),
      gapSeconds: 0,
      hourlyCap: 100,
      recipients: ['later@x.com'],
    });
    await drain();

    await waitFor(async () => {
      const r = await rt.db.query("SELECT count(*)::int AS n FROM emails WHERE campaign_id = $1 AND status = 'SENT'", [dueSoon.campaignId]);
      return r.rows[0].n === 3;
    });

    // Exactly one SMTP message per recipient, no duplicates from the queue.
    expect(sink.received).toHaveLength(3);
    expect(new Set(sink.received.map((m) => m.to)).size).toBe(3);
    expect(sink.transactions).toBe(3);

    // Future email stays scheduled; its job is delayed, not executed.
    const futureRow = (await rt.db.query('SELECT status FROM emails WHERE campaign_id = $1', [future.campaignId])).rows[0];
    expect(futureRow.status).toBe('SCHEDULED');
    expect(await rt.queues.email.getJob(emailJobId((await rt.db.query('SELECT id FROM emails WHERE campaign_id = $1', [future.campaignId])).rows[0].id))).toBeTruthy();

    // Index jobs run for every state change (the dispatcher keeps draining the outbox), and the
    // documents become searchable after an ES refresh (eventual consistency).
    await waitFor(async () => {
      await drain();
      await rt.es.indices.refresh({ index: rt.config.elasticsearch.index });
      const r = await rt.es.count({ index: rt.config.elasticsearch.index, query: { term: { status: 'SENT' } } });
      return r.count === 3;
    });

    const app = rt.app;
    const sent = await request(app)
      .get('/api/emails/search')
      .query({ q: 'Zephyr', view: 'sent' })
      .set('Cookie', owner.cookie);
    expect(sent.status).toBe(200);
    expect(sent.body.items.map((i: { recipient: string }) => i.recipient).sort()).toEqual(['p1@x.com', 'p2@x.com', 'p3@x.com']);
    expect(sent.body.items.every((i: { status: string }) => i.status === 'SENT')).toBe(true);

    const scheduled = await request(app)
      .get('/api/emails/search')
      .query({ q: 'Zephyr', view: 'scheduled' })
      .set('Cookie', owner.cookie);
    expect(scheduled.body.items.map((i: { recipient: string }) => i.recipient)).toEqual(['later@x.com']);

    const foreign = await request(app)
      .get('/api/emails/search')
      .query({ q: 'Zephyr', view: 'sent' })
      .set('Cookie', other.cookie);
    expect(foreign.status).toBe(200);
    expect(foreign.body.items).toEqual([]);
  });
});
