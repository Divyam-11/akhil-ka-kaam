import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import type { Client as EsClient } from '@elastic/elasticsearch';
import type { Redis } from 'ioredis';
import { ZodError } from 'zod';
import type { Db } from '@reachinbox/db';
import type { Clock, Config, Logger, QueueSet } from '@reachinbox/core';
import { accessLog, correlationId, errorHandler, notFoundHandler } from './http/errors.js';
import { loadSession, requireOperator } from './http/session.js';
import { createAuthRouter } from './routes/auth.js';
import { createApiRouter } from './routes/api.js';
import { createHealthRouter } from './routes/health.js';

export interface AppDeps {
  db: Db;
  redis: Redis;
  es: EsClient;
  queues: QueueSet;
  config: Config;
  logger: Logger;
  clock: Clock;
}

export const BULL_BOARD_PATH = '/admin/queues';

export function createApp(deps: AppDeps): express.Express {
  const { config, logger } = deps;
  const app = express();
  app.disable('x-powered-by');

  app.use(correlationId);
  app.use(accessLog(logger));

  // Minimal CORS for direct API callers. The dashboard itself is same-origin through the proxy.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.header('origin');
    if (origin && origin.replace(/\/$/, '') === config.http.webOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token, Idempotency-Key, X-Request-Id');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
      }
    }
    next();
  });

  app.use(['/api', '/auth'], helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: config.http.maxJsonBytes }));
  app.use(loadSession({ db: deps.db, config }));

  app.use(createHealthRouter({ db: deps.db, redis: deps.redis, es: deps.es }));
  app.use(createAuthRouter({ db: deps.db, config, logger, clock: deps.clock }));

  // Operator-only live queue view. Requires a session AND an allowlisted operator email.
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(BULL_BOARD_PATH);
  createBullBoard({
    queues: [deps.queues.email, deps.queues.index, deps.queues.notify].map((q) => new BullMQAdapter(q, { readOnlyMode: true })),
    serverAdapter,
    options: { uiConfig: { boardTitle: 'ReachInbox queues' } },
  });
  app.use(BULL_BOARD_PATH, requireOperator, serverAdapter.getRouter());

  app.use('/api', createApiRouter({ db: deps.db, config, es: deps.es, clock: deps.clock, logger, queues: deps.queues }));

  app.use(notFoundHandler);
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(422).json({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Some fields are invalid',
          details: { issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
          correlationId: String(res.locals.correlationId ?? ''),
        },
      });
      return;
    }
    errorHandler(logger)(err, req, res, next);
  });
  return app;
}
