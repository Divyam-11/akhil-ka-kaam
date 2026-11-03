import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock, deliverEmail } from '@reachinbox/core';
import { createCampaign } from '../../apps/api/src/services/campaigns.js';
import { createRuntime, resetState, seedUser, seedSender, type Runtime, type Seeded } from '../fixtures/harness.js';
import { startSink, type Sink } from '../fixtures/smtp-sink.js';

let rt: Runtime;
let sink: Sink;
let user: Seeded;
const T0 = new Date('2026-11-03T10:00:00.000Z');

beforeAll(async () => {
  sink = await startSink();
});
afterAll(async () => {
  await sink.close();
  await rt?.close();
});
beforeEach(async () => {
  rt = await createRuntime({ clock: new ManualClock(T0), startWorkers: false });
  await resetState(rt);
  sink.reset();
  user = await seedUser(rt.db, rt.config, 'scale@test.local');
});

/** Attempts every non-terminal email once; returns the outcomes. */
async function sweep(): Promise<Record<string, number>> {
  const tally: Record<string, number> = {};
  const ids = (await rt.db.query("SELECT id FROM emails WHERE status IN ('SCHEDULED','DEFERRED') ORDER BY sequence")).rows.map((r) => r.id as string);
  for (const id of ids) {
    const r = await deliverEmail(rt.delivery, id);
    const key = r.kind === 'DEFERRED' ? `DEFERRED:${r.reason}` : r.kind;
    tally[key] = (tally[key] ?? 0) + 1;
  }
  return tally;
}

describe('1,000 synthetic recipients against a shared quota (sink-backed, not Ethereal)', () => {
  it('accounts for every recipient, never overshoots the hourly cap, and resumes in the next UTC hour', async () => {
    const senderId = await seedSender(rt.db, rt.config, user.workspaceId, { port: sink.port, hourlyCap: 500, minGapMs: 0 });
    const recipients = Array.from({ length: 1000 }, (_, i) => `lead${i}@bulk.example`);
    const dto = await createCampaign(rt.db, rt.config, { workspaceId: user.workspaceId }, 'scale-campaign-0001', {
      senderId,
      subject: 'Bulk',
      body: 'Body',
      startAt: new Date(T0.getTime() - 60_000).toISOString(),
      gapSeconds: 0,
      hourlyCap: 500,
      recipients,
    });
    expect(dto.acceptedCount).toBe(1000);

    const first = await sweep();
    expect(first.ACCEPTED).toBe(500);
    expect(first['DEFERRED:SENDER_HOURLY_CAP']).toBe(500);
    expect(sink.transactions).toBe(500);

    const events = (await rt.db.query("SELECT scope_type, hour FROM rate_limit_events ORDER BY scope_type")).rows;
    expect(events.map((e) => e.scope_type)).toEqual(['CAMPAIGN', 'SENDER']);

    // Advance to the next fixed UTC window. Remaining 500 are allowed; nothing is dropped.
    (rt.clock as ManualClock).set(new Date('2026-11-03T11:00:00.000Z'));
    await sweep();
    const counts = (await rt.db.query('SELECT status, count(*)::int AS n FROM emails GROUP BY status')).rows;
    const byStatus = Object.fromEntries(counts.map((c) => [c.status, c.n]));
    expect(byStatus).toEqual({ SENT: 1000 });
    expect(sink.received).toHaveLength(1000);
    expect(new Set(sink.received.map((m) => m.emailHeader)).size).toBe(1000);

    const usage = (await rt.db.query("SELECT hour, attempt_count FROM hourly_usage WHERE scope_type = 'SENDER' ORDER BY hour")).rows;
    expect(usage.map((u) => u.attempt_count)).toEqual([500, 500]);
    const events2 = (await rt.db.query("SELECT count(*)::int AS n FROM rate_limit_events WHERE scope_type = 'SENDER'")).rows[0].n;
    expect(events2).toBe(2);
  }, 180_000);
});
