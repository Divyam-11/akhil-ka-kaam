import type { Db } from '@reachinbox/db';
import { decryptSecret } from '../crypto.js';
import type { Clock } from '../clock.js';
import type { Logger } from '../logger.js';

const SLACK_API = 'https://slack.com/api';

/** Only the incoming-webhook scope is requested. */
export const SLACK_SCOPE = 'incoming-webhook';

export function buildSlackAuthorizeUrl(params: { clientId: string; redirectUri: string; state: string }): string {
  const url = new URL('https://slack.com/oauth/v2/authorize');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('scope', SLACK_SCOPE);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('state', params.state);
  return url.toString();
}

export interface SlackInstallation {
  teamId: string;
  teamName: string;
  channelId: string;
  channelName: string;
  webhookUrl: string;
  accessToken: string | null;
}

/** Exchanges an authorization code server-side and validates the fields we persist. */
export async function exchangeSlackCode(params: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}): Promise<SlackInstallation> {
  const body = new URLSearchParams({
    client_id: params.clientId,
    client_secret: params.clientSecret,
    code: params.code,
    redirect_uri: params.redirectUri,
  });
  const res = await (params.fetchImpl ?? fetch)(`${SLACK_API}/oauth.v2.access`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const json = (await res.json()) as {
    ok?: boolean;
    error?: string;
    access_token?: string;
    team?: { id?: string; name?: string };
    incoming_webhook?: { url?: string; channel?: string; channel_id?: string };
  };
  if (!json.ok) throw new SlackOAuthError(json.error ?? 'oauth_failed');
  const hook = json.incoming_webhook;
  if (!hook?.url || !hook.channel_id || !json.team?.id) {
    throw new SlackOAuthError('incoming_webhook_missing');
  }
  return {
    teamId: json.team.id,
    teamName: json.team.name ?? json.team.id,
    channelId: hook.channel_id,
    channelName: hook.channel ?? hook.channel_id,
    webhookUrl: hook.url,
    accessToken: json.access_token ?? null,
  };
}

export class SlackOAuthError extends Error {
  constructor(readonly code: string) {
    super(`Slack OAuth failed: ${code}`);
  }
}

/** Best-effort revocation of a retained token. Webhook URLs are not revoked by this call. */
export async function revokeSlackToken(token: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`${SLACK_API}/auth.revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json()) as { ok?: boolean };
    return Boolean(json.ok);
  } catch {
    return false;
  }
}

export type WebhookOutcome =
  | { kind: 'DELIVERED'; status: number }
  | { kind: 'RATE_LIMITED'; status: 429; retryAfterMs: number }
  | { kind: 'TRANSIENT'; status: number | null; detail: string }
  | { kind: 'PERMANENT'; status: number; detail: string };

/** Posts one message to an incoming webhook and classifies the HTTP result for the retry policy. */
export async function postWebhook(url: string, text: string, fetchImpl: typeof fetch = fetch): Promise<WebhookOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    // Timeouts can happen after Slack accepted the message, so a retry may duplicate it.
    return { kind: 'TRANSIENT', status: null, detail: (error as Error).name };
  }
  if (res.status >= 200 && res.status < 300) return { kind: 'DELIVERED', status: res.status };
  if (res.status === 429) {
    const header = Number(res.headers.get('retry-after') ?? '1');
    const seconds = Number.isFinite(header) && header > 0 ? header : 1;
    return { kind: 'RATE_LIMITED', status: 429, retryAfterMs: seconds * 1000 };
  }
  if (res.status >= 500) return { kind: 'TRANSIENT', status: res.status, detail: `HTTP ${res.status}` };
  return { kind: 'PERMANENT', status: res.status, detail: `HTTP ${res.status}` };
}

/** Message text. Contains no email bodies, recipients or lead lists. */
export function buildCapMessage(p: {
  scope: 'SENDER' | 'CAMPAIGN';
  senderLabel: string;
  cap: number;
  hour: Date;
  nextWindowAt: Date;
}): string {
  const window = `${p.hour.toISOString().slice(11, 16)}–${p.nextWindowAt.toISOString().slice(11, 16)} UTC`;
  const what = p.scope === 'SENDER' ? `sender "${p.senderLabel}"` : `a campaign sending through "${p.senderLabel}"`;
  return (
    `:warning: ReachInbox: ${what} reached its hourly cap of ${p.cap} emails ` +
    `(window ${window}). Remaining due emails in this window are deferred, not dropped. ` +
    `Next retry window opens at ${p.nextWindowAt.toISOString()}.`
  );
}

export type NotifyResult =
  | { kind: 'DONE' }
  | { kind: 'RETRY_AFTER'; delayMs: number }
  | { kind: 'RETRY_LATER'; detail: string };

/**
 * Sends the Slack notification for one threshold event. Reads the installation at delivery time,
 * so reconnects take effect without a restart, and never sends for a disconnected workspace.
 */
export async function processCapNotification(
  deps: { db: Db; clock: Clock; logger: Logger; encryptionKey: Buffer; fetchImpl?: typeof fetch },
  rateLimitEventId: string,
  isFinalAttempt: boolean,
): Promise<NotifyResult> {
  const ev = (
    await deps.db.query(
      `SELECT e.id, e.scope_type, e.cap, e.hour, e.next_window_at, e.slack_status, e.workspace_id,
              s.label AS sender_label
         FROM rate_limit_events e
         JOIN senders s ON s.id = e.sender_id
        WHERE e.id = $1`,
      [rateLimitEventId],
    )
  ).rows[0];
  if (!ev) return { kind: 'DONE' };
  if (ev.slack_status !== 'PENDING') return { kind: 'DONE' };

  const inst = (
    await deps.db.query(
      'SELECT status, generation, webhook_url_encrypted FROM slack_installations WHERE workspace_id = $1',
      [ev.workspace_id],
    )
  ).rows[0];
  const now = deps.clock.now();
  if (!inst || inst.status !== 'CONNECTED' || !inst.webhook_url_encrypted) {
    await deps.db.query(
      `UPDATE rate_limit_events SET slack_status = 'SKIPPED_DISCONNECTED' WHERE id = $1 AND slack_status = 'PENDING'`,
      [rateLimitEventId],
    );
    return { kind: 'DONE' };
  }
  const generation = inst.generation;
  const webhookUrl = decryptSecret(inst.webhook_url_encrypted, deps.encryptionKey);
  const text = buildCapMessage({
    scope: ev.scope_type,
    senderLabel: ev.sender_label,
    cap: ev.cap,
    hour: new Date(ev.hour),
    nextWindowAt: new Date(ev.next_window_at),
  });

  // Re-check the installation generation immediately before posting. An HTTP request already in
  // flight cannot be recalled if the user disconnects during it.
  const recheck = (
    await deps.db.query('SELECT status, generation FROM slack_installations WHERE workspace_id = $1', [ev.workspace_id])
  ).rows[0];
  if (!recheck || recheck.status !== 'CONNECTED' || recheck.generation !== generation) {
    await deps.db.query(
      `UPDATE rate_limit_events SET slack_status = 'SKIPPED_DISCONNECTED' WHERE id = $1 AND slack_status = 'PENDING'`,
      [rateLimitEventId],
    );
    return { kind: 'DONE' };
  }

  const outcome = await postWebhook(webhookUrl, text, deps.fetchImpl);
  const attemptedAt = now;
  if (outcome.kind === 'DELIVERED') {
    await deps.db.query(
      `UPDATE rate_limit_events SET slack_status = 'SENT', slack_http_status = $2, slack_attempted_at = $3
        WHERE id = $1`,
      [rateLimitEventId, outcome.status, attemptedAt],
    );
    return { kind: 'DONE' };
  }
  if (outcome.kind === 'RATE_LIMITED') return { kind: 'RETRY_AFTER', delayMs: outcome.retryAfterMs };
  if (outcome.kind === 'PERMANENT') {
    await deps.db.query(
      `UPDATE rate_limit_events SET slack_status = 'FAILED', slack_http_status = $2, slack_attempted_at = $3
        WHERE id = $1`,
      [rateLimitEventId, outcome.status, attemptedAt],
    );
    deps.logger.warn({ rateLimitEventId, status: outcome.status }, 'slack webhook rejected permanently');
    return { kind: 'DONE' };
  }
  // Transient: retry with backoff; on the final attempt, record the failure so it stays visible.
  if (isFinalAttempt) {
    await deps.db.query(
      `UPDATE rate_limit_events SET slack_status = 'FAILED', slack_http_status = $2, slack_attempted_at = $3
        WHERE id = $1`,
      [rateLimitEventId, outcome.status, attemptedAt],
    );
    return { kind: 'DONE' };
  }
  return { kind: 'RETRY_LATER', detail: outcome.detail };
}
