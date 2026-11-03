import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processCapNotification, exchangeSlackCode, SlackOAuthError, createLogger, systemClock } from '@reachinbox/core';
import { saveInstallation } from '../../apps/api/src/services/slack.js';
import { withTransaction } from '@reachinbox/db';
import { createRuntime, resetState, seedUser, seedSender, seedSlackConnected, type Runtime, type Seeded } from '../fixtures/harness.js';
import { startWebhookServer, type WebhookServer } from '../fixtures/webhook.js';

let rt: Runtime;
let user: Seeded;
let senderId: string;
let hook: WebhookServer;
const logger = createLogger('test-slack', 'error');

/** Inserts a threshold event the same way the permit transaction does. */
async function insertEvent(hour: string, slackConnected: boolean): Promise<string> {
  const id = (
    await rt.db.query(
      `INSERT INTO rate_limit_events (workspace_id, scope_type, scope_id, sender_id, hour, cap, reached_at, next_window_at, slack_status)
       VALUES ($1, 'SENDER', $2, $2, $3, 2, $3, $3::timestamptz + interval '1 hour', $4) RETURNING id`,
      [user.workspaceId, senderId, hour, slackConnected ? 'PENDING' : 'SKIPPED_NOT_CONNECTED'],
    )
  ).rows[0].id as string;
  return id;
}

beforeAll(async () => {
  hook = await startWebhookServer();
});
afterAll(async () => {
  await hook.close();
  await rt?.close();
});
beforeEach(async () => {
  rt = await createRuntime({ startWorkers: false });
  await resetState(rt);
  hook.hits.length = 0;
  hook.next = [];
  user = await seedUser(rt.db, rt.config, 'slack-owner@test.local');
  senderId = await seedSender(rt.db, rt.config, user.workspaceId, { port: 1, label: 'Ethereal sender 1' });
});

const deps = () => ({ db: rt.db, clock: systemClock, logger, encryptionKey: rt.config.crypto.key });

describe('cap notifications to Slack', () => {
  it('posts one labelled message through the connected webhook and records the HTTP outcome', async () => {
    await seedSlackConnected(rt.db, user.workspaceId, hook.url, rt.config);
    const evId = await insertEvent('2026-11-03T10:00:00Z', true);
    expect(await processCapNotification(deps(), evId, false)).toEqual({ kind: 'DONE' });
    expect(hook.hits).toHaveLength(1);
    const text = hook.hits[0]!.body.text!;
    expect(text).toContain('Ethereal sender 1');
    expect(text).toContain('cap of 2');
    expect(text).toContain('10:00–11:00 UTC');
    expect(text).not.toContain('@');
    const row = (await rt.db.query('SELECT slack_status, slack_http_status FROM rate_limit_events WHERE id = $1', [evId])).rows[0];
    expect(row).toEqual({ slack_status: 'SENT', slack_http_status: 200 });
  });

  it('honours Retry-After on 429 without marking the event failed, then delivers', async () => {
    await seedSlackConnected(rt.db, user.workspaceId, hook.url, rt.config);
    const evId = await insertEvent('2026-11-03T12:00:00Z', true);
    hook.next = [{ status: 429, retryAfter: '2' }];
    const first = await processCapNotification(deps(), evId, false);
    expect(first).toEqual({ kind: 'RETRY_AFTER', delayMs: 2000 });
    expect(hook.hits).toHaveLength(0);
    expect((await processCapNotification(deps(), evId, false))).toEqual({ kind: 'DONE' });
    expect(hook.hits).toHaveLength(1);
  });

  it('retries transient 5xx and records FAILED only on the final attempt', async () => {
    await seedSlackConnected(rt.db, user.workspaceId, hook.url, rt.config);
    const evId = await insertEvent('2026-11-03T13:00:00Z', true);
    hook.next = [{ status: 503 }, { status: 503 }];
    expect((await processCapNotification(deps(), evId, false)).kind).toBe('RETRY_LATER');
    expect((await processCapNotification(deps(), evId, true))).toEqual({ kind: 'DONE' });
    const row = (await rt.db.query('SELECT slack_status, slack_http_status FROM rate_limit_events WHERE id = $1', [evId])).rows[0];
    expect(row).toEqual({ slack_status: 'FAILED', slack_http_status: 503 });
  });

  it('treats a rejected webhook (404) as permanent and does not retry', async () => {
    await seedSlackConnected(rt.db, user.workspaceId, hook.url, rt.config);
    const evId = await insertEvent('2026-11-03T14:00:00Z', true);
    hook.next = [{ status: 404 }];
    expect(await processCapNotification(deps(), evId, false)).toEqual({ kind: 'DONE' });
    const row = (await rt.db.query('SELECT slack_status FROM rate_limit_events WHERE id = $1', [evId])).rows[0];
    expect(row.slack_status).toBe('FAILED');
  });

  it('skips events while disconnected, and resumes on reconnect without re-sending the skipped history', async () => {
    await seedSlackConnected(rt.db, user.workspaceId, hook.url, rt.config);
    await rt.db.query("UPDATE slack_installations SET status = 'DISCONNECTED', generation = generation + 1 WHERE workspace_id = $1", [user.workspaceId]);
    const missed = await insertEvent('2026-11-03T15:00:00Z', true);
    expect(await processCapNotification(deps(), missed, false)).toEqual({ kind: 'DONE' });
    expect(hook.hits).toHaveLength(0);
    expect((await rt.db.query('SELECT slack_status FROM rate_limit_events WHERE id = $1', [missed])).rows[0].slack_status).toBe('SKIPPED_DISCONNECTED');

    await withTransaction(rt.db, (tx) =>
      saveInstallation(tx, rt.config, user.workspaceId, {
        teamId: 'T1',
        teamName: 'Team',
        channelId: 'C1',
        channelName: '#alerts',
        webhookUrl: hook.url,
        accessToken: null,
      }),
    );
    const fresh = await insertEvent('2026-11-03T16:00:00Z', true);
    expect(await processCapNotification(deps(), fresh, false)).toEqual({ kind: 'DONE' });
    expect(hook.hits).toHaveLength(1);
    expect(await processCapNotification(deps(), missed, false)).toEqual({ kind: 'DONE' });
    expect(hook.hits).toHaveLength(1);
  });

  it('marks an event SKIPPED_NOT_CONNECTED at creation when no installation exists', async () => {
    const evId = await insertEvent('2026-11-03T17:00:00Z', false);
    expect(await processCapNotification(deps(), evId, false)).toEqual({ kind: 'DONE' });
    expect(hook.hits).toHaveLength(0);
  });
});

describe('Slack OAuth v2 exchange', () => {
  it('validates the response and returns the webhook for storage', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          access_token: 'xoxb-test-token',
          team: { id: 'T9', name: 'Acme' },
          incoming_webhook: { url: 'https://hooks.slack.com/services/T9/B9/XYZ', channel: '#ops', channel_id: 'C9' },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const inst = await exchangeSlackCode({ clientId: 'c', clientSecret: 's', code: 'code', redirectUri: 'http://localhost:5173/auth/slack/callback', fetchImpl });
    expect(inst).toMatchObject({ teamId: 'T9', channelId: 'C9', channelName: '#ops' });
  });

  it('fails closed when Slack reports an error or omits the webhook', async () => {
    const bad = (async () => new Response(JSON.stringify({ ok: false, error: 'invalid_code' }))) as unknown as typeof fetch;
    await expect(exchangeSlackCode({ clientId: 'c', clientSecret: 's', code: 'x', redirectUri: 'r', fetchImpl: bad })).rejects.toBeInstanceOf(SlackOAuthError);
    const noHook = (async () => new Response(JSON.stringify({ ok: true, team: { id: 'T' } }))) as unknown as typeof fetch;
    await expect(exchangeSlackCode({ clientId: 'c', clientSecret: 's', code: 'x', redirectUri: 'r', fetchImpl: noHook })).rejects.toThrow(/incoming_webhook_missing/);
  });
});
