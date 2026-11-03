import { randomUUID } from 'node:crypto';
import { createPool, type Db } from '@reachinbox/db';
import {
  createEsClient,
  createLogger,
  createQueues,
  createRedis,
  createSmtpTransport,
  createTransportCache,
  encryptSecret,
  getConfig,
  hashToken,
  newOpaqueToken,
  type Clock,
  type Config,
  type DeliveryDeps,
  type Logger,
  type QueueSet,
  DEFAULT_JOB_OPTIONS,
  QUEUE_NAMES,
} from '@reachinbox/core';
import { createProcessors, type Processors } from '../../apps/worker/src/processors.js';
import { startAllWorkers } from '../../apps/worker/src/workers.js';
import { Worker } from 'bullmq';
import type { Client as EsClient } from '@elastic/elasticsearch';
import type { Redis } from 'ioredis';
import { createApp } from '../../apps/api/src/app.js';
import express from 'express';
import { ManualClock } from '@reachinbox/core';
import type { Sink } from './smtp-sink.js';

export const logger: Logger = createLogger('test', 'error');

export interface Runtime {
  config: Config;
  db: Db;
  redis: Redis;
  es: EsClient;
  queues: QueueSet;
  clock: ManualClock | Clock;
  processors: Processors;
  delivery: DeliveryDeps;
  workers: Worker[];
  app: express.Express;
  close(): Promise<void>;
}

/** Full in-process runtime wired to the real PostgreSQL, Redis and Elasticsearch of the test stack. */
export async function createRuntime(opts: { clock?: ManualClock; startWorkers?: boolean; smtpDeadlineMs?: number } = {}): Promise<Runtime> {
  const config = getConfig();
  const db = createPool(config.database.url, 10);
  const redis = createRedis(config.redis.url, `test-${randomUUID().slice(0, 8)}`);
  const es = createEsClient(config.elasticsearch.url);
  const queues = createQueues(redis);
  const clock = opts.clock ?? { now: () => new Date() };
  const transports = createTransportCache(config.crypto.key, (cfg) =>
    createSmtpTransport(cfg, {
      connectionTimeoutMs: 5000,
      greetingTimeoutMs: 5000,
      socketTimeoutMs: 5000,
    }),
  );
  const delivery: DeliveryDeps = {
    db,
    clock,
    logger,
    encryptionKey: config.crypto.key,
    smtpDeadlineMs: opts.smtpDeadlineMs ?? 15_000,
    attemptGraceMs: 2000,
    transportFor: (senderId, enc) => transports.get(senderId, enc),
  };
  const processors = createProcessors({
    db,
    clock,
    logger,
    encryptionKey: config.crypto.key,
    delivery,
    es,
    indexName: config.elasticsearch.index,
  });
  const workers =
    opts.startWorkers === false
      ? []
      : startAllWorkers({
          redis,
          concurrency: config.sending.workerConcurrency,
          email: processors.email,
          index: processors.index,
          notify: processors.notify,
          logger,
        });
  const app = createApp({ db, redis, es, queues, config, logger, clock: { now: () => clock.now() } });
  return {
    config,
    db,
    redis,
    es,
    queues,
    clock,
    processors,
    delivery,
    workers,
    app,
    async close() {
      await Promise.allSettled(workers.map((w) => w.close(true)));
      transports.closeAll();
      await queues.close().catch(() => undefined);
      await es.close().catch(() => undefined);
      await db.end().catch(() => undefined);
      redis.disconnect();
    },
  };
}

/** Empties every application table (keeps migrations) and the test queues. */
export async function resetState(rt: Pick<Runtime, 'db' | 'queues' | 'config' | 'redis'>): Promise<void> {
  await rt.db.query(`
    TRUNCATE outbox_events, rate_limit_events, hourly_usage, delivery_attempts, emails, campaigns,
             senders, sender_pool, slack_installations, sessions, oauth_states, workspaces, users
    RESTART IDENTITY CASCADE`);
  // Test-only Redis database (index 1). Refuse to flush anything else, so a development database is never touched.
  if (!/\/1$/.test(rt.config.redis.url)) throw new Error('Refusing to flush a Redis database that is not the test database (/1)');
  await rt.redis.flushdb();
}

export interface Seeded {
  userId: string;
  workspaceId: string;
  cookie: string;
  csrf: string;
}

export async function seedUser(db: Db, config: Config, email: string, opts: { operator?: boolean } = {}): Promise<Seeded> {
  const sub = `sub-${randomUUID()}`;
  const user = (
    await db.query(
      `INSERT INTO users (google_sub, email, name) VALUES ($1, $2, $3) RETURNING id`,
      [sub, email, email.split('@')[0]],
    )
  ).rows[0];
  const ws = (
    await db.query(`INSERT INTO workspaces (owner_user_id, name) VALUES ($1, 'Test workspace') RETURNING id`, [user.id])
  ).rows[0];
  const token = newOpaqueToken(32);
  const csrf = newOpaqueToken(24);
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES ($1, $2, $3, now() + interval '1 hour')`,
    [hashToken(token, config.session.secret), user.id, csrf],
  );
  void opts;
  return { userId: user.id, workspaceId: ws.id, cookie: `ri_session=${token}`, csrf };
}

export interface SenderSeed {
  label?: string;
  port: number;
  hourlyCap?: number;
  minGapMs?: number;
  fromAddress?: string;
}

export async function seedSender(db: Db, config: Config, workspaceId: string, s: SenderSeed): Promise<string> {
  const cfg = JSON.stringify({ host: '127.0.0.1', port: s.port, secure: false, user: 'sink', pass: 'sink' });
  const row = (
    await db.query(
      `INSERT INTO senders (workspace_id, label, from_address, smtp_config_encrypted, hourly_cap, min_gap_ms)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        workspaceId,
        s.label ?? `Sink ${s.port}`,
        s.fromAddress ?? 'sender@sink.test',
        encryptSecret(cfg, config.crypto.key),
        s.hourlyCap ?? 10_000,
        s.minGapMs ?? 0,
      ],
    )
  ).rows[0];
  return row.id as string;
}

export async function seedSlackConnected(db: Db, workspaceId: string, webhookUrl: string, config: Config): Promise<void> {
  await db.query(
    `INSERT INTO slack_installations (workspace_id, status, generation, team_id, team_name, channel_id, channel_name,
                                      webhook_url_encrypted, connected_at, updated_at)
     VALUES ($1, 'CONNECTED', 1, 'T1', 'Test team', 'C1', '#alerts', $2, now(), now())`,
    [workspaceId, encryptSecret(webhookUrl, config.crypto.key)],
  );
}

export function sinkSecretFree(sink: Sink): boolean {
  return sink.received.every((m) => !m.headers.includes('sink-pass'));
}

export { DEFAULT_JOB_OPTIONS, QUEUE_NAMES };
