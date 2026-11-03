import { DelayedError, type Job } from 'bullmq';
import type { Db } from '@reachinbox/db';
import {
  bulkIndexDocuments,
  deliverEmail,
  loadIndexDocuments,
  processCapNotification,
  type Clock,
  type Logger,
  type DeliveryDeps,
} from '@reachinbox/core';
import type { Client as EsClient } from '@elastic/elasticsearch';

export interface ProcessorDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  encryptionKey: Buffer;
  delivery: DeliveryDeps;
  es: EsClient;
  indexName: string;
  notifyFetch?: typeof fetch;
}

/**
 * BullMQ processors. Email jobs consult the database before every decision and never trust the
 * queue payload beyond the email ID. Deferral uses moveToDelayed + DelayedError so the job keeps
 * its retry budget and is woken at the correct time.
 */
export function createProcessors(d: ProcessorDeps) {
  return {
    email: async (job: Job<{ emailId: string }>, token?: string) => {
      const result = await deliverEmail(d.delivery, job.data.emailId);
      if (result.kind === 'DEFERRED') {
        await job.moveToDelayed(result.nextAt.getTime(), token);
        throw new DelayedError();
      }
      return { outcome: result.kind };
    },

    index: async (job: Job<{ items: Array<{ emailId: string; version: number }> }>) => {
      const docs = await loadIndexDocuments(d.db, job.data.items.map((i) => i.emailId));
      const result = await bulkIndexDocuments(d.es, d.indexName, docs);
      if (result.failed > 0) throw new Error(`index bulk had ${result.failed} failed items`);
      return { indexed: result.indexed, ignoredStale: result.ignoredStale };
    },

    notify: async (job: Job<{ rateLimitEventId: string }>, token?: string) => {
      const maxAttempts = job.opts.attempts ?? 1;
      const result = await processCapNotification(
        { db: d.db, clock: d.clock, logger: d.logger, encryptionKey: d.encryptionKey, fetchImpl: d.notifyFetch },
        job.data.rateLimitEventId,
        job.attemptsMade + 1 >= maxAttempts,
      );
      if (result.kind === 'RETRY_AFTER') {
        await job.moveToDelayed(Date.now() + result.delayMs, token);
        throw new DelayedError();
      }
      if (result.kind === 'RETRY_LATER') throw new Error(result.detail);
      return { done: true };
    },
  };
}

export type Processors = ReturnType<typeof createProcessors>;
