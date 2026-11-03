import { createPool } from '@reachinbox/db';
import {
  createEsClient,
  createLogger,
  createRedis,
  createSmtpTransport,
  createTransportCache,
  ensureIndex,
  getConfig,
  QUEUE_NAMES,
  systemClock,
  type DeliveryDeps,
} from '@reachinbox/core';
import { createProcessors } from './processors.js';
import { startAllWorkers } from './workers.js';

async function main(): Promise<void> {
  const config = getConfig();
  const logger = createLogger('worker', config.logLevel);
  const db = createPool(config.database.url, 20);
  const redis = createRedis(config.redis.url, 'worker');
  const es = createEsClient(config.elasticsearch.url);
  const smtpTimeouts = config.sending.smtp;
  const smtpDeadlineMs =
    smtpTimeouts.connectionTimeoutMs + smtpTimeouts.greetingTimeoutMs + smtpTimeouts.socketTimeoutMs + 5000;

  const transports = createTransportCache(config.crypto.key, (cfg) => createSmtpTransport(cfg, smtpTimeouts));
  const delivery: DeliveryDeps = {
    db,
    clock: systemClock,
    logger,
    encryptionKey: config.crypto.key,
    smtpDeadlineMs,
    attemptGraceMs: 15_000,
    transportFor: (senderId, encrypted) => transports.get(senderId, encrypted),
  };

  // Index creation is best-effort at boot: sending keeps working while Elasticsearch is down.
  ensureIndex(es, config.elasticsearch.index).catch((error: unknown) =>
    logger.warn({ err: String(error) }, 'elasticsearch not ready at boot; indexing jobs will retry'),
  );

  const processors = createProcessors({
    db,
    clock: systemClock,
    logger,
    encryptionKey: config.crypto.key,
    delivery,
    es,
    indexName: config.elasticsearch.index,
  });

  const workers = startAllWorkers({
    redis,
    concurrency: config.sending.workerConcurrency,
    email: processors.email,
    index: processors.index,
    notify: processors.notify,
    logger,
  });

  logger.info({ concurrency: config.sending.workerConcurrency, queues: Object.values(QUEUE_NAMES) }, 'worker started');

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'worker shutting down: no new claims; in-flight work settles');
    await Promise.all(workers.map((w) => w.close()));
    transports.closeAll();
    await db.end().catch(() => undefined);
    await es.close().catch(() => undefined);
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
