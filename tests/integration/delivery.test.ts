import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock, reservePermit, recoverStaleAttempts, deliverEmail, emailJobId, QUEUE_NAMES } from '@reachinbox/core';
import { createCampaign } from '../../apps/api/src/services/campaigns.js';
import { createRuntime, resetState, seedUser, seedSender, seedSlackConnected, type Runtime, type Seeded } from '../fixtures/harness.js';
import { startSink, type Sink } from '../fixtures/smtp-sink.js';
import { startWebhookServer, type WebhookServer } from '../fixtures/webhook.js';

let rt: Runtime;
let sink: Sink;
let user: Seeded;
let senderId: string;
let useRealClock = false;

const T0 = new Date('2026-11-03T10:00:00.000Z');

async function campaign(opts: {
  recipients: string[];
  hourlyCap?: number;
  gapSeconds?: number;
  startAt?: Date;
  senderIdOverride?: string;
  workspaceId?: string;
}) {
  const body = {
    senderId: opts.senderIdOverride ?? senderId,
    subject: 'Quarterly update',
    body: 'Plain text body',
    startAt: (opts.startAt ?? new Date(rt.clock.now().getTime() - 60_000)).toISOString(),
    gapSeconds: opts.gapSeconds ?? 0,
    hourlyCap: opts.hourlyCap ?? 100,
    recipients: opts.recipients,
  };
  const dto = await createCampaign(rt.db, rt.config, { workspaceId: opts.workspaceId ?? user.workspaceId }, `key-${Math.random().toString(36).slice(2, 12)}`, body);
  return dto.campaignId;
}

async function emailIds(campaignId: string): Promise<string[]> {
  return (await rt.db.query('SELECT id FROM emails WHERE campaign_id = $1 ORDER BY sequence', [campaignId])).rows.map((r) => r.id);
}

async function row(id: string) {
  return (await rt.db.query('SELECT * FROM emails WHERE id = $1', [id])).rows[0];
}

beforeAll(async () => {
  sink = await startSink();
});
afterAll(async () => {
  await sink.close();
});
beforeEach(async () => {
  rt = await createRuntime({ clock: useRealClock ? undefined : new ManualClock(T0), startWorkers: false });
  await resetState(rt);
  sink.reset();
  user = await seedUser(rt.db, rt.config, 'owner@test.local');
  senderId = await seedSender(rt.db, rt.config, user.workspaceId, { port: sink.port, hourlyCap: 100, minGapMs: 0 });
});
afterAll(async () => {
  await rt?.close();
});

describe('single delivery', () => {
  it('sends one future-due email once, records the attempt and makes later calls no-ops', async () => {
    const [id] = await emailIds(await campaign({ recipients: ['ada@example.com'] }));
    const first = await deliverEmail(rt.delivery, id!);
    expect(first.kind).toBe('ACCEPTED');
    const r = await row(id!);
    expect(r.status).toBe('SENT');
    expect(r.sent_at).not.toBeNull();
    expect(r.message_id).toBeTruthy();
    expect(sink.received).toHaveLength(1);
    expect(sink.received[0]!.to).toBe('ada@example.com');
    expect(sink.received[0]!.emailHeader).toBe(id);

    const second = await deliverEmail(rt.delivery, id!);
    expect(second).toEqual({ kind: 'SKIPPED', reason: 'TERMINAL' });
    expect(sink.received).toHaveLength(1);
    expect(sink.transactions).toBe(1);
  });

  it('does not submit an email scheduled in the future', async () => {
    const [id] = await emailIds(await campaign({ recipients: ['later@example.com'], startAt: new Date(T0.getTime() + 3_600_000) }));
    const result = await deliverEmail(rt.delivery, id!);
    expect(result).toMatchObject({ kind: 'DEFERRED', reason: 'NOT_YET_DUE' });
    expect(sink.transactions).toBe(0);
    expect((await row(id!)).status).toBe('SCHEDULED');
  });

  it('marks a definite SMTP rejection as FAILED and never resubmits it', async () => {
    await sink.close();
    sink = await startSink({ rejectPrefix: 'reject@' });
    await rt.db.query('UPDATE senders SET smtp_config_encrypted = $1 WHERE id = $2', [
      (await import('@reachinbox/core')).encryptSecret(JSON.stringify({ host: '127.0.0.1', port: sink.port, secure: false, user: 'u', pass: 'p' }), rt.config.crypto.key),
      senderId,
    ]);
    const [id] = await emailIds(await campaign({ recipients: ['reject@example.com'] }));
    const result = await deliverEmail(rt.delivery, id!);
    expect(result.kind).toBe('REJECTED');
    const r = await row(id!);
    expect(r.status).toBe('FAILED');
    expect(r.last_error).toMatch(/SMTP 550/);
    expect(await deliverEmail(rt.delivery, id!)).toEqual({ kind: 'SKIPPED', reason: 'TERMINAL' });
  });

  it('turns an ambiguous connection loss into DELIVERY_UNCERTAIN and never resends', async () => {
    await sink.close();
    sink = await startSink({ dropPrefix: 'drop@' });
    await rt.db.query('UPDATE senders SET smtp_config_encrypted = $1 WHERE id = $2', [
      (await import('@reachinbox/core')).encryptSecret(JSON.stringify({ host: '127.0.0.1', port: sink.port, secure: false, user: 'u', pass: 'p' }), rt.config.crypto.key),
      senderId,
    ]);
    const [id] = await emailIds(await campaign({ recipients: ['drop@example.com'] }));
    const result = await deliverEmail(rt.delivery, id!);
    expect(result.kind).toBe('UNCERTAIN');
    expect((await row(id!)).status).toBe('DELIVERY_UNCERTAIN');
    const before = sink.transactions;
    expect(await deliverEmail(rt.delivery, id!)).toEqual({ kind: 'SKIPPED', reason: 'TERMINAL' });
    expect(sink.transactions).toBe(before);
    const attempt = (await rt.db.query('SELECT status FROM delivery_attempts WHERE email_id = $1', [id])).rows[0];
    expect(attempt.status).toBe('UNCERTAIN');
  });

  it('recovers a stale attempt left by a crashed worker as UNCERTAIN, without touching SMTP', async () => {
    const [id] = await emailIds(await campaign({ recipients: ['crash@example.com'] }));
    // Simulate: permit committed, then the process died before SMTP. Deadline already passed.
    const permit = await reservePermit(rt.db, { emailId: id!, now: T0, attemptDeadlineMs: -60_000, attemptGraceMs: 0 });
    expect(permit.kind).toBe('SEND');
    expect((await row(id!)).status).toBe('SENDING');

    const resolved = await recoverStaleAttempts(rt.db, new Date(T0.getTime() + 1000));
    expect(resolved).toBe(1);
    expect((await row(id!)).status).toBe('DELIVERY_UNCERTAIN');
    expect(sink.transactions).toBe(0);
    const sender = (await rt.db.query('SELECT active_attempt_token FROM senders WHERE id = $1', [senderId])).rows[0];
    expect(sender.active_attempt_token).toBeNull();
    expect(await deliverEmail(rt.delivery, id!)).toEqual({ kind: 'SKIPPED', reason: 'TERMINAL' });
  });
});

describe('sender and campaign limits (deterministic clock)', () => {
  it('defers the third email when the sender cap is 2, records one threshold event and notifies Slack once', async () => {
    const webhook: WebhookServer = await startWebhookServer();
    try {
      await seedSlackConnected(rt.db, user.workspaceId, webhook.url, rt.config);
      await rt.db.query('UPDATE senders SET hourly_cap = 2 WHERE id = $1', [senderId]);
      const ids = await emailIds(await campaign({ recipients: ['a@x.com', 'b@x.com', 'c@x.com'] }));

      const results = [];
      for (const id of ids) results.push(await deliverEmail(rt.delivery, id));
      expect(results.map((r) => r.kind)).toEqual(['ACCEPTED', 'ACCEPTED', 'DEFERRED']);
      const deferred = results[2] as { reason: string; nextAt: Date };
      expect(deferred.reason).toBe('SENDER_HOURLY_CAP');
      expect(deferred.nextAt.toISOString()).toBe('2026-11-03T11:00:00.000Z');
      expect(sink.transactions).toBe(2);

      const third = await row(ids[2]!);
      expect(third.status).toBe('DEFERRED');
      expect(third.deferral_reason).toBe('SENDER_HOURLY_CAP');

      const events = (await rt.db.query("SELECT scope_type, slack_status FROM rate_limit_events WHERE workspace_id = $1", [user.workspaceId])).rows;
      expect(events).toEqual([{ scope_type: 'SENDER', slack_status: 'PENDING' }]);
      const notify = (await rt.db.query("SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'SLACK_NOTIFY'")).rows[0];
      expect(notify.n).toBe(1);

      // Another attempt within the same hour defers again and does not create a second event.
      await deliverEmail(rt.delivery, ids[2]!);
      const again = (await rt.db.query('SELECT count(*)::int AS n FROM rate_limit_events')).rows[0];
      expect(again.n).toBe(1);
    } finally {
      await webhook.close();
    }
  });

  it('records the threshold as SKIPPED_NOT_CONNECTED when Slack is not installed', async () => {
    await rt.db.query('UPDATE senders SET hourly_cap = 1 WHERE id = $1', [senderId]);
    const ids = await emailIds(await campaign({ recipients: ['a@x.com', 'b@x.com'] }));
    await deliverEmail(rt.delivery, ids[0]!);
    expect((await deliverEmail(rt.delivery, ids[1]!)).kind).toBe('DEFERRED');
    const ev = (await rt.db.query('SELECT slack_status FROM rate_limit_events')).rows[0];
    expect(ev.slack_status).toBe('SKIPPED_NOT_CONNECTED');
    expect((await rt.db.query("SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'SLACK_NOTIFY'")).rows[0].n).toBe(0);
  });

  it('honours a low campaign cap independently of a generous sender cap', async () => {
    const ids = await emailIds(await campaign({ recipients: ['a@x.com', 'b@x.com', 'c@x.com'], hourlyCap: 1 }));
    expect((await deliverEmail(rt.delivery, ids[0]!)).kind).toBe('ACCEPTED');
    const second = await deliverEmail(rt.delivery, ids[1]!);
    expect(second).toMatchObject({ kind: 'DEFERRED', reason: 'CAMPAIGN_HOURLY_CAP' });
    // Reaching the campaign cap produces exactly one clearly-labelled campaign threshold event.
    const campaignEvent = (await rt.db.query("SELECT scope_type FROM rate_limit_events WHERE scope_type = 'CAMPAIGN'")).rows;
    expect(campaignEvent).toHaveLength(1);
  });

  it('defers for pacing without consuming hourly quota and resumes when the gap elapses', async () => {
    await rt.db.query('UPDATE senders SET min_gap_ms = 60000 WHERE id = $1', [senderId]);
    const ids = await emailIds(await campaign({ recipients: ['a@x.com', 'b@x.com'] }));
    expect((await deliverEmail(rt.delivery, ids[0]!)).kind).toBe('ACCEPTED');
    const paced = await deliverEmail(rt.delivery, ids[1]!);
    expect(paced).toMatchObject({ kind: 'DEFERRED', reason: 'SENDER_PACING' });
    const usage = (await rt.db.query("SELECT attempt_count FROM hourly_usage WHERE scope_type = 'SENDER'")).rows[0];
    expect(usage.attempt_count).toBe(1);
    (rt.clock as ManualClock).advanceMs(61_000);
    expect((await deliverEmail(rt.delivery, ids[1]!)).kind).toBe('ACCEPTED');
  });

  it('releases the deferral at the next UTC hour boundary and sends again', async () => {
    await rt.db.query('UPDATE senders SET hourly_cap = 1 WHERE id = $1', [senderId]);
    const ids = await emailIds(await campaign({ recipients: ['a@x.com', 'b@x.com'] }));
    await deliverEmail(rt.delivery, ids[0]!);
    expect((await deliverEmail(rt.delivery, ids[1]!)).kind).toBe('DEFERRED');
    (rt.clock as ManualClock).set(new Date('2026-11-03T10:59:59.999Z'));
    expect((await deliverEmail(rt.delivery, ids[1]!)).kind).toBe('DEFERRED');
    (rt.clock as ManualClock).set(new Date('2026-11-03T11:00:00.000Z'));
    expect((await deliverEmail(rt.delivery, ids[1]!)).kind).toBe('ACCEPTED');
    expect(sink.received.map((m) => m.to).sort()).toEqual(['a@x.com', 'b@x.com']);
  });
});

describe('concurrency', () => {
  beforeAll(() => {
    useRealClock = true;
  });
  afterAll(() => {
    useRealClock = false;
  });

  it('serialises SMTP per sender while two workers race on the same sender', async () => {
    await sink.close();
    sink = await startSink({ dataDelayMs: 120 });
    await rt.db.query('UPDATE senders SET smtp_config_encrypted = $1 WHERE id = $2', [
      (await import('@reachinbox/core')).encryptSecret(JSON.stringify({ host: '127.0.0.1', port: sink.port, secure: false, user: 'u', pass: 'p' }), rt.config.crypto.key),
      senderId,
    ]);
    const recipients = Array.from({ length: 6 }, (_, i) => `r${i}@x.com`);
    const ids = await emailIds(await campaign({ recipients }));
    const sendUntilDone = async (id: string) => {
      for (let i = 0; i < 400; i += 1) {
        const r = await deliverEmail(rt.delivery, id);
        if (r.kind !== 'DEFERRED') return r;
        await new Promise((res) => setTimeout(res, 20));
      }
      throw new Error('never settled');
    };
    // Two independent "workers" each take half the emails concurrently.
    const results = await Promise.all([
      ...ids.slice(0, 3).map(sendUntilDone),
      ...ids.slice(3).map(sendUntilDone),
    ]);
    expect(results.every((r) => r.kind === 'ACCEPTED')).toBe(true);
    expect(sink.maxConcurrentData).toBe(1);
    expect(sink.received).toHaveLength(6);
    expect(new Set(sink.received.map((m) => m.emailHeader)).size).toBe(6);
  });

  it('never exceeds the hourly cap when many emails race for the last slots', async () => {
    await rt.db.query('UPDATE senders SET hourly_cap = 3 WHERE id = $1', [senderId]);
    const ids = await emailIds(await campaign({ recipients: Array.from({ length: 10 }, (_, i) => `z${i}@x.com`) }));
    const burst = await Promise.all(ids.map((id) => deliverEmail(rt.delivery, id)));
    expect(burst.filter((r) => r.kind === 'ACCEPTED').length).toBeLessThanOrEqual(3);
    // Keep trying sequentially until the cap is exhausted; then the next attempt must defer by cap.
    for (let round = 0; round < 50; round += 1) {
      const used = (await rt.db.query("SELECT coalesce(max(attempt_count),0) AS n FROM hourly_usage WHERE scope_type = 'SENDER'")).rows[0].n;
      if (Number(used) >= 3) break;
      for (const id of ids) await deliverEmail(rt.delivery, id);
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(sink.received).toHaveLength(3);
    const usage = (await rt.db.query("SELECT attempt_count FROM hourly_usage WHERE scope_type = 'SENDER'")).rows[0];
    expect(usage.attempt_count).toBe(3);
    // Make a still-deferred email due now, as its job would be at the cap boundary. Without this the
    // probe can be gated by NOT_YET_DUE (next UTC hour) before the cap check is reached.
    const unsent = (await rt.db.query("SELECT id FROM emails WHERE status <> 'SENT' LIMIT 1")).rows[0].id as string;
    await rt.db.query('UPDATE emails SET next_attempt_at = now() WHERE id = $1', [unsent]);
    const after = await deliverEmail(rt.delivery, unsent);
    expect(after).toMatchObject({ kind: 'DEFERRED', reason: 'SENDER_HOURLY_CAP' });
    expect(sink.received).toHaveLength(3);
  });
});

describe('queue naming', () => {
  it('uses colon-free stable job IDs for deliveries', () => {
    expect(emailJobId('abc')).toBe('email-abc');
    expect(QUEUE_NAMES.email).toBe('email-delivery');
  });
});
