import { createApp } from './app.js';
import { pruneExpiredAuthRows } from './routes/auth.js';
import { createPool } from '@reachinbox/db';
import {
  createEsClient,
  createLogger,
  createQueues,
  createRedis,
  getConfig,
  systemClock,
} from '@reachinbox/core';

async function main(): Promise<void> {
  const config = getConfig();
  const logger = createLogger('api', config.logLevel);
  const db = createPool(config.database.url, 10);
  const redis = createRedis(config.redis.url, 'api');
  const es = createEsClient(config.elasticsearch.url);
  const queues = createQueues(redis);

  const app = createApp({ db, redis, es, queues, config, logger, clock: systemClock });
  const server = app.listen(config.http.port, () => {
    logger.info({ port: config.http.port, webOrigin: config.http.webOrigin }, 'api listening');
  });

  const pruner = setInterval(() => {
    pruneExpiredAuthRows(db).catch((error: unknown) => logger.warn({ err: String(error) }, 'prune failed'));
  }, 10 * 60 * 1000);
  pruner.unref();

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'api shutting down');
    clearInterval(pruner);
    server.close(() => {
      void Promise.allSettled([queues.close(), db.end()]).then(() => {
        redis.disconnect();
        process.exit(0);
      });
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
