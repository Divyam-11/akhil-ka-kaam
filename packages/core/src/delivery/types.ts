import type { Clock } from '../clock.js';
import type { Logger } from '../logger.js';
import type { Db } from '@reachinbox/db';
import type { SmtpTransport } from '../smtp/index.js';

export type DeferReason =
  | 'NOT_YET_DUE'
  | 'SENDER_IN_FLIGHT'
  | 'SENDER_PACING'
  | 'CAMPAIGN_PACING'
  | 'SENDER_HOURLY_CAP'
  | 'CAMPAIGN_HOURLY_CAP';

export interface SendPayload {
  emailId: string;
  workspaceId: string;
  campaignId: string;
  senderId: string;
  senderLabel: string;
  fromAddress: string;
  smtpConfigEncrypted: string;
  recipient: string;
  subject: string;
  body: string;
}

/**
 * Outcome of the permit transaction. Only SEND leads to an SMTP call, and only once per email.
 * DEFER never consumes an SMTP attempt or the job's retry budget.
 */
export type PermitOutcome =
  | { kind: 'SKIP'; reason: 'NOT_FOUND' | 'TERMINAL' | 'ALREADY_SENDING'; status?: string }
  | { kind: 'DEFER'; reason: DeferReason; nextAt: Date }
  | { kind: 'SEND'; attemptToken: string; deadlineAt: Date; payload: SendPayload };

export interface PermitInput {
  emailId: string;
  now: Date;
  attemptDeadlineMs: number;
  attemptGraceMs: number;
}

export type DeliveryResult =
  | { kind: 'SKIPPED'; reason: string }
  | { kind: 'DEFERRED'; reason: DeferReason; nextAt: Date }
  | { kind: 'ACCEPTED'; emailId: string; messageId: string | null }
  | { kind: 'REJECTED'; emailId: string; detail: string }
  | { kind: 'UNCERTAIN'; emailId: string; detail: string };

export interface DeliveryDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  encryptionKey: Buffer;
  smtpDeadlineMs: number;
  attemptGraceMs: number;
  transportFor(senderId: string, encryptedConfig: string): SmtpTransport;
}
