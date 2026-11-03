import { Queue, type JobsOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { sha256Hex } from './crypto.js';

/** Queue names. Kept in one place so API, worker, dispatcher and Bull Board agree. */
export const QUEUE_NAMES = {
  email: 'email-delivery',
  index: 'search-index',
  notify: 'slack-notify',
} as const;

export const JOB_NAMES = {
  deliverEmail: 'deliver-email',
  indexEmails: 'index-emails',
  notifySlack: 'notify-slack',
} as const;

// Custom BullMQ job IDs must not contain colons. Every ID is derived from a durable DB key so the
// dispatcher can replay publication after a crash and BullMQ de-duplicates it.
export function emailJobId(emailId: string): string {
  return `email-${emailId}`;
}

export function slackJobId(rateLimitEventId: string): string {
  return `slack-${rateLimitEventId}`;
}

/** Deterministic ID for a batch of (emailId, version) index items, independent of ordering. */
export function indexJobId(items: ReadonlyArray<{ emailId: string; version: number }>): string {
  const canonical = items
    .map((i) => `${i.emailId}.${i.version}`)
    .sort()
    .join('|');
  return `index-${sha256Hex(canonical).slice(0, 40)}`;
}

export const DEFAULT_JOB_OPTIONS: Record<keyof typeof QUEUE_NAMES, JobsOptions> = {
  email: {
    attempts: 10,
    backoff: { type: 'exponential', delay: 2000 },
    // Completed jobs are retained a week so duplicate publications are de-duplicated by BullMQ.
    // The database check in the worker is still the real guard against duplicate sends.
    removeOnComplete: { age: 7 * 24 * 3600, count: 200_000 },
    removeOnFail: { count: 50_000 },
  },
  index: {
    attempts: 8,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { age: 24 * 3600, count: 20_000 },
    removeOnFail: { count: 10_000 },
  },
  notify: {
    attempts: 6,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { age: 7 * 24 * 3600, count: 20_000 },
    removeOnFail: { count: 10_000 },
  },
};

export interface QueueSet {
  email: Queue;
  index: Queue;
  notify: Queue;
  close(): Promise<void>;
}

/** Producer-side queues (no workers). Uses the caller's Redis connection. */
export function createQueues(connection: Redis): QueueSet {
  const make = (name: string, opts: JobsOptions) =>
    new Queue(name, { connection, defaultJobOptions: opts });
  const email = make(QUEUE_NAMES.email, DEFAULT_JOB_OPTIONS.email);
  const index = make(QUEUE_NAMES.index, DEFAULT_JOB_OPTIONS.index);
  const notify = make(QUEUE_NAMES.notify, DEFAULT_JOB_OPTIONS.notify);
  return {
    email,
    index,
    notify,
    async close() {
      await Promise.all([email.close(), index.close(), notify.close()]);
    },
  };
}
