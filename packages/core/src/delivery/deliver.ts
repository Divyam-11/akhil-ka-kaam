import { decryptSecret } from '../crypto.js';
import { previewUrlFor, classifySmtpError, type SmtpTransport } from '../smtp/index.js';
import { reservePermit } from './permit.js';
import { settleAttempt } from './settle.js';
import type { DeliveryDeps, DeliveryResult, SendPayload } from './types.js';

const SETTLE_RETRIES = 3;

/**
 * End-to-end delivery of one email:
 *   permit transaction -> (single) SMTP submission -> settlement transaction.
 * The caller (BullMQ worker) must move the job to delayed on DEFERRED and must not retry an
 * already-STARTED attempt; this function is idempotent for terminal and in-flight emails.
 */
export async function deliverEmail(deps: DeliveryDeps, emailId: string): Promise<DeliveryResult> {
  const now = deps.clock.now();
  const permit = await reservePermit(deps.db, {
    emailId,
    now,
    attemptDeadlineMs: deps.smtpDeadlineMs,
    attemptGraceMs: deps.attemptGraceMs,
  });

  if (permit.kind === 'SKIP') {
    deps.logger.debug({ emailId, reason: permit.reason }, 'delivery skipped');
    return { kind: 'SKIPPED', reason: permit.reason };
  }
  if (permit.kind === 'DEFER') {
    deps.logger.debug({ emailId, reason: permit.reason, nextAt: permit.nextAt }, 'delivery deferred');
    return { kind: 'DEFERRED', reason: permit.reason, nextAt: permit.nextAt };
  }

  return submitAndSettle(deps, permit.payload, permit.attemptToken);
}

async function submitAndSettle(
  deps: DeliveryDeps,
  payload: SendPayload,
  attemptToken: string,
): Promise<DeliveryResult> {
  // Exactly one SMTP submission for this attempt. nodemailer does not retry on its own.
  let transport: SmtpTransport;
  try {
    transport = deps.transportFor(payload.senderId, payload.smtpConfigEncrypted);
  } catch (error) {
    return settle(deps, payload, attemptToken, 'REJECTED', null, null, `Sender configuration unusable: ${(error as Error).name}`);
  }

  try {
    const info = await transport.sendMail({
      from: payload.fromAddress,
      to: payload.recipient,
      subject: payload.subject,
      text: payload.body,
      headers: { 'X-ReachInbox-Email': payload.emailId },
    });
    const accepted = Array.isArray(info.accepted) && info.accepted.length > 0;
    if (!accepted) {
      return settle(deps, payload, attemptToken, 'REJECTED', null, null, 'SMTP accepted no recipients');
    }
    return settle(deps, payload, attemptToken, 'ACCEPTED', info.messageId ?? null, previewUrlFor(info));
  } catch (error) {
    const classified = classifySmtpError(error);
    const outcome = classified.failureClass === 'UNCERTAIN' ? 'UNCERTAIN' : 'REJECTED';
    deps.logger.warn(
      { emailId: payload.emailId, senderId: payload.senderId, failureClass: classified.failureClass },
      'smtp submission failed',
    );
    return settle(deps, payload, attemptToken, outcome, null, null, classified.detail);
  }
}

async function settle(
  deps: DeliveryDeps,
  payload: SendPayload,
  attemptToken: string,
  outcome: 'ACCEPTED' | 'REJECTED' | 'UNCERTAIN',
  messageId: string | null,
  previewUrl: string | null,
  detail?: string,
): Promise<DeliveryResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= SETTLE_RETRIES; attempt += 1) {
    try {
      await settleAttempt(deps.db, {
        emailId: payload.emailId,
        senderId: payload.senderId,
        attemptToken,
        outcome,
        now: deps.clock.now(),
        messageId,
        previewUrl,
        detail: detail ?? null,
      });
      if (outcome === 'ACCEPTED') return { kind: 'ACCEPTED', emailId: payload.emailId, messageId };
      if (outcome === 'REJECTED') return { kind: 'REJECTED', emailId: payload.emailId, detail: detail ?? 'rejected' };
      return { kind: 'UNCERTAIN', emailId: payload.emailId, detail: detail ?? 'unknown' };
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 200 * attempt));
    }
  }
  // The attempt stays STARTED; recovery converts it to UNCERTAIN. The email is never resent.
  deps.logger.error({ emailId: payload.emailId, err: String(lastError) }, 'settlement failed; deferred to recovery');
  throw lastError;
}

export function createTransportCache(
  encryptionKey: Buffer,
  factory: (cfg: { host: string; port: number; secure: boolean; user: string; pass: string }) => SmtpTransport,
): { get(senderId: string, encrypted: string): SmtpTransport; closeAll(): void } {
  const cache = new Map<string, SmtpTransport>();
  return {
    get(senderId, encrypted) {
      const existing = cache.get(senderId);
      if (existing) return existing;
      const cfg = JSON.parse(decryptSecret(encrypted, encryptionKey)) as {
        host: string;
        port: number;
        secure: boolean;
        user: string;
        pass: string;
      };
      const transport = factory(cfg);
      cache.set(senderId, transport);
      return transport;
    },
    closeAll() {
      for (const t of cache.values()) t.close();
      cache.clear();
    },
  };
}

