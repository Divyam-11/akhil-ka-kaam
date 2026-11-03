import './env.js';
import pg from 'pg';
import { createPool, migrate } from '@reachinbox/db';
import { createEsClient, ensureIndex } from '@reachinbox/core';
import { getConfig } from '@reachinbox/core';

/** Creates the test database if needed, migrates it and resets the test search index. */
export default async function setup(): Promise<void> {
  const url = new URL(process.env.DATABASE_URL!);
  const dbName = url.pathname.slice(1);
  const admin = new pg.Client({ connectionString: new URL('/postgres', url).toString() });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (!exists.rowCount) await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const db = createPool(process.env.DATABASE_URL!, 2);
  await migrate(db);
  await db.end();

  const config = getConfig();
  const es = createEsClient(config.elasticsearch.url);
  await es.indices.delete({ index: config.elasticsearch.index }, { ignore: [404] }).catch(() => undefined);
  await ensureIndex(es, config.elasticsearch.index);
  await es.close();
}
