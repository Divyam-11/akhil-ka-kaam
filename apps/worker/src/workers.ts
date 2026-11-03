import { Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { QUEUE_NAMES, type Logger } from '@reachinbox/core';

export interface WorkerHandlers {
  redis: Redis;
  concurrency: number;
  email: (job: Job<{ emailId: string }>, token?: string) => Promise<unknown>;
  index: (job: Job<{ items: Array<{ emailId: string; version: number }> }>) => Promise<unknown>;
  notify: (job: Job<{ rateLimitEventId: string }>, token?: string) => Promise<unknown>;
  logger: Logger;
  /** Override the default per-queue concurrency (tests use this). */
  indexConcurrency?: number;
}

/**
 * Starts the three BullMQ workers in one process. Each uses the same Redis connection shape.
 * The email worker takes a long lock because one SMTP attempt may legitimately run for a while.
 */
export function startAllWorkers(h: WorkerHandlers): Worker[] {
  const connection = h.redis;
  const email = new Worker(QUEUE_NAMES.email, h.email as never, {
    connection,
    concurrency: h.concurrency,
    lockDuration: 60_000,
    stalledInterval: 30_000,
  });
  const index = new Worker(QUEUE_NAMES.index, h.index as never, {
    connection,
    concurrency: h.indexConcurrency ?? 2,
    lockDuration: 60_000,
  });
  const notify = new Worker(QUEUE_NAMES.notify, h.notify as never, {
    connection,
    concurrency: 2,
    lockDuration: 60_000,
  });
  for (const [name, w] of [
    ['email', email],
    ['index', index],
    ['notify', notify],
  ] as const) {
    w.on('failed', (job, err) =>
      h.logger.warn({ queue: name, jobId: job?.id, attempts: job?.attemptsMade, err: err.message }, 'job failed'),
    );
    w.on('error', (err) => h.logger.error({ queue: name, err: err.message }, 'worker error'));
  }
  return [email, index, notify];
}
