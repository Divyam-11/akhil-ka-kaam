import '../fixtures/env.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime, resetState, seedUser, seedSender } from '../fixtures/harness.js';
import { migrate } from '@reachinbox/db';
import { ensureIndex } from '@reachinbox/core';
import { startSink, type Sink } from '../fixtures/smtp-sink.js';

/**
 * E2E setup: fresh test data, one owner workspace with a session cookie, and a controlled SMTP sink
 * acting as the sender. The session is created directly in the test database; this is a test
 * fixture and is never part of the product login path (Google OIDC is).
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const rt = await createRuntime({ startWorkers: false });
  await migrate(rt.db);
  await ensureIndex(rt.es, rt.config.elasticsearch.index);
  await resetState(rt);
  const sink: Sink = await startSink();
  const owner = await seedUser(rt.db, rt.config, 'owner@e2e.test');
  await seedSender(rt.db, rt.config, owner.workspaceId, { port: sink.port, label: 'Sink sender 1', fromAddress: 'sink1@e2e.test' });
  await seedSender(rt.db, rt.config, owner.workspaceId, { port: sink.port, label: 'Sink sender 2', fromAddress: 'sink2@e2e.test' });
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test-results');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'e2e-session.json'), JSON.stringify({ cookie: owner.cookie, sinkPort: sink.port }));
  return async () => {
    await sink.close();
    await rt.close();
  };
}
