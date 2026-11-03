import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { leaseOutboxBatch, markPublished, publishBatch, reconcilePendingJobs, emailJobId, createLogger, systemClock } from '@reachinbox/core';
import { createCampaign } from '../../apps/api/src/services/campaigns.js';
import { createRuntime, resetState, seedUser, seedSender, type Runtime, type Seeded } from '../fixtures/harness.js';
import { startSink, type Sink } from '../fixtures/smtp-sink.js';

let rt: Runtime;
let sink: Sink;
let user: Seeded;
let senderId: string;
const logger = createLogger('test-outbox', 'error');

async function scheduleThree(startInMs = 5000): Promise<string[]> {
  const dto = await createCampaign(
    rt.db,
    rt.config,
    { workspaceId: user.workspaceId },
    `outbox-${Math.random().toString(36).slice(2, 10)}`,
    {
      senderId,
      subject: 'Outbox',
      body: 'Body',
      startAt: new Date(Date.now() + startInMs).toISOString(),
      gapSeconds: 0,
      hourlyCap: 100,
      recipients: ['one@x.com', 'two@x.com', 'three@x.com'],
    },
  );
  return (await rt.db.query('SELECT id FROM emails WHERE campaign_id = $1 ORDER BY sequence', [dto.campaignId])).rows.map(
    (r) => r.id as string,
  );
}

async function drain(): Promise<{ published: number; failed: number }> {
  const total = { published: 0, failed: 0 };
  for (;;) {
    const batch = await leaseOutboxBatch(rt.db, { limit: 100, leaseMs: 30_000 });
    if (batch.events.length === 0) return total;
    const r = await publishBatch(rt.db, rt.queues, logger, batch, systemClock.now());
    total.published += r.published;
    total.failed += r.failed;
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
  rt = await createRuntime({ startWorkers: false });
  await resetState(rt);
  user = await seedUser(rt.db, rt.config, 'outbox@test.local');
  senderId = await seedSender(rt.db, rt.config, user.workspaceId, { port: sink.port });
});

describe('transactional outbox publication', () => {
  it('publishes one stable, delayed BullMQ job per email and marks intents published', async () => {
    const ids = await scheduleThree();
    const pending = await rt.db.query('SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL');
    expect(pending.rows[0].n).toBe(6); // 3 enqueue + 3 index intents, committed with the campaign

    const result = await drain();
    expect(result).toEqual({ published: 6, failed: 0 });
    const counts = await rt.queues.email.getJobCounts('delayed');
    expect(counts.delayed).toBe(3);
    for (const id of ids) {
      const job = await rt.queues.email.getJob(emailJobId(id));
      expect(job).toBeTruthy();
      expect(job!.opts.delay).toBeGreaterThan(3000); // delay = scheduled_at - now
    }
    expect((await rt.db.query('SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL')).rows[0].n).toBe(0);
  });

  it('survives a crash after enqueue but before the outbox acknowledgement (replay creates no duplicates)', async () => {
    const ids = await scheduleThree();
    await drain();
    // Simulate: BullMQ accepted the jobs, but the dispatcher died before marking the rows published.
    await rt.db.query('UPDATE outbox_events SET published_at = NULL, lease_token = NULL, lease_expires_at = NULL');
    const replay = await drain();
    expect(replay.published).toBe(6);
    expect((await rt.queues.email.getJobCounts('delayed')).delayed).toBe(3);
    for (const id of ids) expect(await rt.queues.email.getJob(emailJobId(id))).toBeTruthy();
  });

  it('recovers intents whose dispatcher crashed while holding a lease', async () => {
    await scheduleThree();
    // Lease everything, then "crash": never publish. Expire the lease.
    const leased = await leaseOutboxBatch(rt.db, { limit: 100, leaseMs: 30_000 });
    expect(leased.events).toHaveLength(6);
    expect((await leaseOutboxBatch(rt.db, { limit: 100, leaseMs: 30_000 })).events).toHaveLength(0);
    await rt.db.query("UPDATE outbox_events SET lease_expires_at = now() - interval '1 second'");
    const recovered = await drain();
    expect(recovered.published).toBe(6);
    expect((await rt.queues.email.getJobCounts('delayed')).delayed).toBe(3);
  });

  it('ignores a stale lease token when marking rows published', async () => {
    await scheduleThree();
    const first = await leaseOutboxBatch(rt.db, { limit: 2, leaseMs: 30_000 });
    await rt.db.query("UPDATE outbox_events SET lease_expires_at = now() - interval '1 second'");
    const second = await leaseOutboxBatch(rt.db, { limit: 2, leaseMs: 30_000 });
    expect(second.events.length).toBeGreaterThan(0);
    await markPublished(rt.db, first.token, first.events.map((e) => e.id));
    const stillPending = await rt.db.query('SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL');
    expect(stillPending.rows[0].n).toBe(6);
  });
});

describe('boot reconciliation', () => {
  it('rebuilds only the missing job and leaves healthy jobs untouched', async () => {
    const ids = await scheduleThree(60_000);
    await drain();
    const before = await rt.queues.email.getJob(emailJobId(ids[1]!));
    const healthyBefore = await rt.queues.email.getJob(emailJobId(ids[0]!));
    await (await rt.queues.email.getJob(emailJobId(ids[2]!)))!.remove();

    const result = await reconcilePendingJobs(rt.db, rt.queues, logger, { now: () => systemClock.now() });
    expect(result).toMatchObject({ scanned: 3, republished: 1 });
    const rebuilt = await rt.queues.email.getJob(emailJobId(ids[2]!));
    expect(rebuilt).toBeTruthy();
    expect(rebuilt!.opts.delay).toBeGreaterThan(50_000);
    // Existing jobs keep their original creation timestamps (not re-timed from startup).
    expect((await rt.queues.email.getJob(emailJobId(ids[1]!)))!.timestamp).toBe(before!.timestamp);
    expect((await rt.queues.email.getJob(emailJobId(ids[0]!)))!.timestamp).toBe(healthyBefore!.timestamp);
    expect((await rt.queues.email.getJobCounts('delayed')).delayed).toBe(3);
  });

  it('does not create jobs for emails that already have an SMTP attempt', async () => {
    const ids = await scheduleThree(60_000);
    await rt.db.query(
      `INSERT INTO delivery_attempts (email_id, sender_id, attempt_token, status, started_at, deadline_at, finished_at, error_class)
       VALUES ($1, $2, gen_random_uuid(), 'UNCERTAIN', now(), now(), now(), 'STALE')`,
      [ids[0], senderId],
    );
    await rt.db.query("UPDATE emails SET status = 'DELIVERY_UNCERTAIN' WHERE id = $1", [ids[0]]);
    const result = await reconcilePendingJobs(rt.db, rt.queues, logger, { now: () => systemClock.now() });
    expect(result.scanned).toBe(2);
    expect(await rt.queues.email.getJob(emailJobId(ids[0]!))).toBeUndefined();
  });
});
