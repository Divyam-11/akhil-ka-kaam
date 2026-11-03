import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  analyzeRecipients,
  normalizeRecipient,
  createCampaignBodySchema,
  SCHEDULED_VIEW_STATUSES,
  SENT_VIEW_STATUSES,
} from '@reachinbox/contracts';
import {
  decryptSecret,
  encryptSecret,
  hashToken,
  indexJobId,
  emailJobId,
  slackJobId,
  utcHourStart,
  nextUtcHour,
  classifySmtpError,
  buildCapMessage,
  buildSlackAuthorizeUrl,
  parseConfig,
} from '@reachinbox/core';
import { encodeListCursor, decodeListCursor } from '../../apps/api/src/services/emails.js';
import { encodeCursor, decodeCursor } from '@reachinbox/core';

describe('recipient normalisation', () => {
  it('trims, strips BOM, lowercases only the domain and keeps local-part case', () => {
    expect(normalizeRecipient('﻿  Ada.Lovelace@Example.COM ')).toEqual({ ok: true, value: 'Ada.Lovelace@example.com' });
  });
  it('rejects blanks, missing @, and malformed addresses', () => {
    expect(normalizeRecipient('   ')).toEqual({ ok: false, reason: 'EMPTY' });
    expect(normalizeRecipient('no-at-sign')).toEqual({ ok: false, reason: 'INVALID_FORMAT' });
    expect(normalizeRecipient('a b@example.com')).toEqual({ ok: false, reason: 'INVALID_FORMAT' });
    expect(normalizeRecipient('x@localhost')).toEqual({ ok: false, reason: 'INVALID_FORMAT' });
  });
  it('reports valid, invalid and duplicate counts without losing blank-row accounting', () => {
    const report = analyzeRecipients(['a@x.com', 'A@x.com', 'a@x.com', 'bad', '', 'b@y.org']);
    expect(report).toMatchObject({ total: 6, valid: 3, invalid: 1, duplicates: 1 });
    expect(report.unique).toEqual(['a@x.com', 'A@x.com', 'b@y.org']);
  });
});

describe('request schema', () => {
  const base = {
    senderId: '6f1f8a7e-3c2b-4a1d-9e8f-1234567890ab',
    subject: 'Hello',
    body: 'Plain text',
    startAt: '2026-11-03T10:00:00Z',
    gapSeconds: 60,
    hourlyCap: 5,
    recipients: ['a@x.com'],
  };
  it('accepts a UTC instant and bounded values', () => {
    expect(createCampaignBodySchema.safeParse(base).success).toBe(true);
  });
  it('rejects local-time strings without a Z suffix and out-of-range caps', () => {
    expect(createCampaignBodySchema.safeParse({ ...base, startAt: '2026-11-03T10:00:00+02:00' }).success).toBe(false);
    expect(createCampaignBodySchema.safeParse({ ...base, hourlyCap: 0 }).success).toBe(false);
    expect(createCampaignBodySchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
  it('keeps scheduled and sent status sets disjoint and complete', () => {
    const all = new Set([...SCHEDULED_VIEW_STATUSES, ...SENT_VIEW_STATUSES]);
    expect(all.size).toBe(SCHEDULED_VIEW_STATUSES.length + SENT_VIEW_STATUSES.length);
    expect(all.has('DELIVERY_UNCERTAIN')).toBe(true);
  });
});

describe('secrets', () => {
  const key = randomBytes(32);
  it('round-trips AES-256-GCM envelopes and rejects tampering', () => {
    const enc = encryptSecret('https://hooks.example/abc', key);
    expect(enc.startsWith('v1:')).toBe(true);
    expect(decryptSecret(enc, key)).toBe('https://hooks.example/abc');
    const tampered = enc.slice(0, -2) + (enc.endsWith('AA') ? 'BB' : 'AA');
    expect(() => decryptSecret(tampered, key)).toThrow();
  });
  it('produces different ciphertexts for the same plaintext (random IV)', () => {
    expect(encryptSecret('x', key)).not.toBe(encryptSecret('x', key));
  });
  it('keys session tokens with HMAC so the stored hash is not the cookie', () => {
    const h = hashToken('cookie-value', 'server-secret-000000000000000000000');
    expect(h).not.toContain('cookie-value');
    expect(h).toHaveLength(64);
  });
});

describe('UTC hour windows', () => {
  it('truncates to the fixed UTC hour and computes the next boundary', () => {
    const at = new Date('2026-11-03T10:59:59.999Z');
    expect(utcHourStart(at).toISOString()).toBe('2026-11-03T10:00:00.000Z');
    expect(nextUtcHour(at).toISOString()).toBe('2026-11-03T11:00:00.000Z');
  });
  it('places the exact boundary instant in the new window', () => {
    expect(utcHourStart(new Date('2026-11-03T11:00:00.000Z')).toISOString()).toBe('2026-11-03T11:00:00.000Z');
  });
});

describe('job identifiers', () => {
  it('never contain colons (BullMQ custom IDs)', () => {
    const id = '6f1f8a7e-3c2b-4a1d-9e8f-1234567890ab';
    for (const v of [emailJobId(id), slackJobId(id), indexJobId([{ emailId: id, version: 3 }])]) {
      expect(v.includes(':')).toBe(false);
    }
  });
  it('index job IDs are order-independent and change with version', () => {
    const a = { emailId: 'e1', version: 1 };
    const b = { emailId: 'e2', version: 4 };
    expect(indexJobId([a, b])).toBe(indexJobId([b, a]));
    expect(indexJobId([a])).not.toBe(indexJobId([{ emailId: 'e1', version: 2 }]));
  });
});

describe('SMTP failure classification', () => {
  it('treats a server reply code as a definite rejection', () => {
    expect(classifySmtpError(Object.assign(new Error('x'), { responseCode: 550, command: 'RCPT TO' })).failureClass).toBe('REJECTED');
  });
  it('treats connect/auth/DNS failures as not sent', () => {
    expect(classifySmtpError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })).failureClass).toBe('NOT_SENT');
    expect(classifySmtpError(Object.assign(new Error('x'), { code: 'EAUTH' })).failureClass).toBe('NOT_SENT');
  });
  it('treats timeouts and resets as uncertain, with no secrets in the detail', () => {
    const c = classifySmtpError(Object.assign(new Error('socket hang up pass=secret'), { code: 'ECONNRESET' }));
    expect(c.failureClass).toBe('UNCERTAIN');
    expect(c.detail).not.toContain('secret');
  });
});

describe('Slack messages and OAuth URL', () => {
  it('describes the cap without email bodies or recipients', () => {
    const msg = buildCapMessage({
      scope: 'SENDER',
      senderLabel: 'Ethereal sender 1',
      cap: 2,
      hour: new Date('2026-11-03T10:00:00Z'),
      nextWindowAt: new Date('2026-11-03T11:00:00Z'),
    });
    expect(msg).toContain('Ethereal sender 1');
    expect(msg).toContain('cap of 2');
    expect(msg).toContain('10:00–11:00 UTC');
    expect(msg).not.toMatch(/@/);
  });
  it('requests only the incoming-webhook scope', () => {
    const url = new URL(buildSlackAuthorizeUrl({ clientId: 'cid', redirectUri: 'http://localhost:5173/auth/slack/callback', state: 's' }));
    expect(url.searchParams.get('scope')).toBe('incoming-webhook');
    expect(url.origin).toBe('https://slack.com');
  });
});

describe('cursors', () => {
  it('round-trips the search cursor and the list cursor', () => {
    expect(decodeCursor(encodeCursor([1700000000000, 'abc']))).toEqual([1700000000000, 'abc']);
    const c = { t: '2026-11-03T10:00:00.000Z', id: '6f1f8a7e-3c2b-4a1d-9e8f-1234567890ab' };
    expect(decodeListCursor(encodeListCursor(c))).toEqual(c);
  });
});

describe('configuration', () => {
  const base = {
    DATABASE_URL: 'postgres://u:p@h/db',
    SESSION_SECRET: 'x'.repeat(32),
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  };
  it('applies documented defaults', () => {
    const c = parseConfig(base);
    expect(c.sending.workerConcurrency).toBe(5);
    expect(c.sending.minSendDelayMs).toBe(2000);
    expect(c.sending.maxEmailsPerHourPerSender).toBe(200);
    expect(c.http.cookieSecure).toBe(false);
  });
  it('fails loudly on a short encryption key or session secret', () => {
    expect(() => parseConfig({ ...base, ENCRYPTION_KEY: 'AAAA' })).toThrow(/ENCRYPTION_KEY/);
    expect(() => parseConfig({ ...base, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
  });
});
