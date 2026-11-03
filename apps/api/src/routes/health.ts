import { Router, type Request, type Response } from 'express';
import type { Client as EsClient } from '@elastic/elasticsearch';
import type { Redis } from 'ioredis';
import type { Db } from '@reachinbox/db';
import type { HealthDto } from '@reachinbox/contracts';

export function createHealthRouter(deps: { db: Db; redis: Redis; es: EsClient }): Router {
  const router = Router();

  // Liveness: the process is running and serving HTTP. No dependency checks.
  router.get('/health/live', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  // Readiness: core dependencies (PostgreSQL, Redis) gate readiness. Elasticsearch failure is
  // reported as degraded. Slack is not checked here at all, so it cannot take sending down.
  router.get('/health/ready', async (_req: Request, res: Response) => {
    const checks: HealthDto['checks'] = {};
    const probe = async (name: string, fn: () => Promise<unknown>): Promise<boolean> => {
      try {
        await Promise.race([
          fn(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000).unref()),
        ]);
        checks[name] = { ok: true };
        return true;
      } catch (error) {
        checks[name] = { ok: false, detail: (error as Error).message };
        return false;
      }
    };
    const coreOk = [
      await probe('postgres', () => deps.db.query('SELECT 1')),
      await probe('redis', () => deps.redis.ping()),
    ].every(Boolean);
    const searchOk = await probe('elasticsearch', () => deps.es.ping());

    const status: HealthDto['status'] = !coreOk ? 'down' : searchOk ? 'ok' : 'degraded';
    res.status(coreOk ? 200 : 503).json({ status, checks } satisfies HealthDto);
  });

  return router;
}
