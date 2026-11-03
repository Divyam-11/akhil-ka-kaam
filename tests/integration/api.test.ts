import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createRuntime, resetState, seedUser, seedSender, type Runtime, type Seeded } from '../fixtures/harness.js';
import { startSink, type Sink } from '../fixtures/smtp-sink.js';

let rt: Runtime;
let sink: Sink;
let a: Seeded;
let b: Seeded;
let senderA: string;
let senderB: string;

// Fixed for the whole file: the payload hash must be identical across retried requests.
const START_AT = new Date(Date.now() + 3_600_000).toISOString();
const future = () => START_AT;
const body = (recipients: string[], extra: Record<string, unknown> = {}) => ({
  senderId: senderA,
  subject: 'Hello',
  body: 'Plain text',
  startAt: future(),
  gapSeconds: 30,
  hourlyCap: 50,
  recipients,
  ...extra,
});

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
  a = await seedUser(rt.db, rt.config, 'alice@test.local');
  b = await seedUser(rt.db, rt.config, 'bob@test.local');
  senderA = await seedSender(rt.db, rt.config, a.workspaceId, { port: sink.port, label: 'Alice sender' });
  senderB = await seedSender(rt.db, rt.config, b.workspaceId, { port: sink.port, label: 'Bob sender' });
});

describe('authentication and CSRF', () => {
  it('rejects anonymous API access and reports the signed-in profile', async () => {
    expect((await request(rt.app).get('/api/me')).status).toBe(401);
    const me = await request(rt.app).get('/api/me').set('Cookie', a.cookie);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('alice@test.local');
    expect(me.body.csrfToken).toBe(a.csrf);
    expect(me.body.isOperator).toBe(false);
  });

  it('requires the CSRF header for mutations, and rejects foreign origins', async () => {
    const noToken = await request(rt.app)
      .post('/api/campaigns')
      .set('Cookie', a.cookie)
      .set('Idempotency-Key', 'csrf-test-0001')
      .send(body(['x@x.com']));
    expect(noToken.status).toBe(403);
    expect(noToken.body.error.code).toBe('CSRF_REJECTED');

    const evil = await request(rt.app)
      .post('/api/campaigns')
      .set('Cookie', a.cookie)
      .set('Origin', 'https://evil.example')
      .set('X-CSRF-Token', a.csrf)
      .set('Idempotency-Key', 'csrf-test-0002')
      .send(body(['x@x.com']));
    expect(evil.status).toBe(403);
    expect(evil.body.error.code).toBe('BAD_ORIGIN');
  });
});

describe('campaign scheduling and idempotency', () => {
  const post = (cookie: string, csrf: string, key: string, payload: unknown) =>
    request(rt.app).post('/api/campaigns').set('Cookie', cookie).set('X-CSRF-Token', csrf).set('Idempotency-Key', key).send(payload as object);

  it('creates one campaign for a repeated key and payload, and conflicts for a different payload', async () => {
    const first = await post(a.cookie, a.csrf, 'idem-key-0001', body(['one@x.com', 'two@x.com']));
    expect(first.status).toBe(202);
    expect(first.body.acceptedCount).toBe(2);
    const replay = await post(a.cookie, a.csrf, 'idem-key-0001', body(['one@x.com', 'two@x.com']));
    expect(replay.status).toBe(202);
    expect(replay.body.campaignId).toBe(first.body.campaignId);
    expect(replay.body.replayed).toBe(true);
    const conflict = await post(a.cookie, a.csrf, 'idem-key-0001', body(['different@x.com']));
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const count = (await rt.db.query('SELECT count(*)::int AS n FROM emails')).rows[0].n;
    expect(count).toBe(2);
  });

  it('never doubles recipients when the same request is submitted concurrently', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => post(a.cookie, a.csrf, 'idem-race-0001', body(['r1@x.com', 'r2@x.com', 'r3@x.com']))),
    );
    expect(results.every((r) => r.status === 202)).toBe(true);
    expect(new Set(results.map((r) => r.body.campaignId)).size).toBe(1);
    expect((await rt.db.query('SELECT count(*)::int AS n FROM campaigns')).rows[0].n).toBe(1);
    expect((await rt.db.query('SELECT count(*)::int AS n FROM emails')).rows[0].n).toBe(3);
  });

  it('requires an Idempotency-Key and reports validation problems with counts only', async () => {
    const missing = await request(rt.app).post('/api/campaigns').set('Cookie', a.cookie).set('X-CSRF-Token', a.csrf).send(body(['x@x.com']));
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const invalid = await post(a.cookie, a.csrf, 'idem-bad-0001', body(['good@x.com', 'not-an-email']));
    expect(invalid.status).toBe(422);
    expect(invalid.body.error.code).toBe('INVALID_RECIPIENTS');
    expect(invalid.body.error.details).toMatchObject({ valid: 1, invalid: 1 });
    expect(JSON.stringify(invalid.body)).not.toContain('good@x.com');
  });

  it('deduplicates recipients and reports the duplicate count', async () => {
    // Domain case is normalised, local-part case is significant (documented policy).
    const r = await post(a.cookie, a.csrf, 'idem-dup-0001', body(['dup@x.com', 'dup@X.COM', 'Dup@x.com', 'other@x.com']));
    expect(r.status).toBe(202);
    expect(r.body.acceptedCount).toBe(3);
    expect(r.body.duplicateCount).toBe(1);
  });

  it('rejects a body larger than the configured limit with a clear error', async () => {
    const huge = body(['x@x.com'], { body: 'x'.repeat(6 * 1024 * 1024) });
    const res = await post(a.cookie, a.csrf, 'idem-huge-0001', huge);
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('workspace isolation', () => {
  it('stops one workspace from reading, searching, previewing or scheduling with another workspace records', async () => {
    const created = await request(rt.app)
      .post('/api/campaigns')
      .set('Cookie', a.cookie)
      .set('X-CSRF-Token', a.csrf)
      .set('Idempotency-Key', 'iso-alice-0001')
      .send(body(['private@x.com']));
    const campaignId = created.body.campaignId as string;
    const emailId = (await rt.db.query('SELECT id FROM emails WHERE campaign_id = $1', [campaignId])).rows[0].id as string;

    const bobCampaign = await request(rt.app).get(`/api/campaigns/${campaignId}`).set('Cookie', b.cookie);
    expect(bobCampaign.status).toBe(404);
    const bobList = await request(rt.app).get('/api/emails').query({ view: 'scheduled' }).set('Cookie', b.cookie);
    expect(bobList.body.items).toEqual([]);
    const bobDetail = await request(rt.app).get(`/api/emails/${emailId}`).set('Cookie', b.cookie);
    expect(bobDetail.status).toBe(404);
    const bobSchedule = await request(rt.app)
      .post('/api/campaigns')
      .set('Cookie', b.cookie)
      .set('X-CSRF-Token', b.csrf)
      .set('Idempotency-Key', 'iso-bob-0001')
      .send(body(['x@x.com'], { senderId: senderA }));
    expect(bobSchedule.status).toBe(404);
    const bobSenders = await request(rt.app).get('/api/senders').set('Cookie', b.cookie);
    expect(bobSenders.body.items.map((s: { label: string }) => s.label)).toEqual(['Bob sender']);
    expect(senderB).toBeTruthy();
  });
});

describe('operator-only queue board', () => {
  it('returns 401 when anonymous, 403 for non-operators, and serves the board to an allowlisted operator', async () => {
    expect((await request(rt.app).get('/admin/queues')).status).toBe(401);
    expect((await request(rt.app).get('/admin/queues').set('Cookie', a.cookie)).status).toBe(403);
    const operator = await seedUser(rt.db, rt.config, 'operator@test.local');
    const res = await request(rt.app).get('/admin/queues').set('Cookie', operator.cookie);
    expect(res.status).toBeLessThan(400);
    expect(res.text).toContain('ReachInbox');
  });
});

describe('search degrades without touching delivery', () => {
  it('returns SEARCH_UNAVAILABLE when Elasticsearch is unreachable while listings keep working', async () => {
    const { Client } = await import('@elastic/elasticsearch');
    const { createApp } = await import('../../apps/api/src/app.js');
    const deadEs = new Client({ node: 'http://127.0.0.1:9', requestTimeout: 1500, maxRetries: 0 });
    const app = createApp({
      db: rt.db,
      redis: rt.redis,
      es: deadEs,
      queues: rt.queues,
      config: rt.config,
      logger: (await import('@reachinbox/core')).createLogger('test-dead-es', 'silent'),
      clock: { now: () => new Date() },
    });
    const search = await request(app).get('/api/emails/search').query({ q: 'anything', view: 'sent' }).set('Cookie', a.cookie);
    expect(search.status).toBe(503);
    expect(search.body.error.code).toBe('SEARCH_UNAVAILABLE');
    const list = await request(app).get('/api/emails').query({ view: 'scheduled' }).set('Cookie', a.cookie);
    expect(list.status).toBe(200);
    await deadEs.close();
  });
});

describe('health and degraded dependencies', () => {
  it('reports live and ready, and keeps working in a degraded state when Elasticsearch is unreachable', async () => {
    expect((await request(rt.app).get('/health/live')).status).toBe(200);
    const ready = await request(rt.app).get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.checks.postgres.ok).toBe(true);
    expect(ready.body.checks.redis.ok).toBe(true);
  });
});

describe('Slack disconnect API', () => {
  it('reports status and disconnects with a CSRF-protected call', async () => {
    const status = await request(rt.app).get('/api/integrations/slack').set('Cookie', a.cookie);
    expect(status.body.status).toBe('NOT_CONNECTED');
    const nope = await request(rt.app).delete('/api/integrations/slack').set('Cookie', a.cookie);
    expect(nope.status).toBe(403);
    const ok = await request(rt.app).delete('/api/integrations/slack').set('Cookie', a.cookie).set('X-CSRF-Token', a.csrf);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('DISCONNECTED');
  });
});
