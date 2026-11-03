import { createPool } from '@reachinbox/db';
import {
  createLogger,
  createQueues,
  createRedis,
  clearOrphanSenderMarkers,
  getConfig,
  leaseOutboxBatch,
  publishBatch,
  reconcilePendingJobs,
  recoverStaleAttempts,
  systemClock,
} from '@reachinbox/core';

const MAINTENANCE_EVERY_MS = 15_000;
const IDLE_MIN_MS = 50;
const IDLE_MAX_MS = 2000;

/**
 * Transactional outbox dispatcher. It never sends email: it only publishes stable BullMQ jobs for
 * committed database intents and runs ambiguous-attempt recovery. Safe to run several copies.
 */
async function main(): Promise<void> {
  const config = getConfig();
  const logger = createLogger('dispatcher', config.logLevel);
  const db = createPool(config.database.url, 10);
  const redis = createRedis(config.redis.url, 'dispatcher');
  const queues = createQueues(redis);
  let running = true;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Boot-time reconciliation: rebuild missing BullMQ jobs for pending rows with no SMTP attempt.
  for (let attempt = 1; running; attempt += 1) {
    try {
      await reconcilePendingJobs(db, queues, logger, { now: () => systemClock.now() });
      break;
    } catch (error) {
      logger.warn({ err: String(error), attempt }, 'boot reconciliation failed; retrying');
      await sleep(Math.min(10_000, 500 * attempt));
    }
  }

  let lastMaintenance = 0;
  let idle = IDLE_MIN_MS;

  const maintenance = async () => {
    const now = systemClock.now();
    const recovered = await recoverStaleAttempts(db, now);
    const cleared = await clearOrphanSenderMarkers(db, now);
    if (recovered || cleared) {
      logger.warn({ recoveredUncertain: recovered, clearedMarkers: cleared }, 'stale delivery attempts resolved');
    }
  };

  logger.info({ batchSize: config.dispatcher.batchSize }, 'dispatcher started');
  while (running) {
    try {
      if (Date.now() - lastMaintenance > MAINTENANCE_EVERY_MS) {
        lastMaintenance = Date.now();
        await maintenance();
      }
      const batch = await leaseOutboxBatch(db, {
        limit: config.dispatcher.batchSize,
        leaseMs: config.dispatcher.leaseMs,
      });
      if (batch.events.length === 0) {
        await sleep(idle);
        idle = Math.min(IDLE_MAX_MS, idle * 2);
        continue;
      }
      idle = IDLE_MIN_MS;
      const result = await publishBatch(db, queues, logger, batch, systemClock.now());
      if (result.failed > 0) await sleep(250);
    } catch (error) {
      logger.error({ err: String(error) }, 'dispatcher iteration failed');
      await sleep(1000);
    }
  }

  const shutdown = async (signal: string) => {
    running = false;
    logger.info({ signal }, 'dispatcher stopping after current batch');
    await sleep(100);
    await queues.close().catch(() => undefined);
    await db.end().catch(() => undefined);
    redis.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
