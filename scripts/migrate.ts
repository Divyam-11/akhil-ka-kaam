import { createPool, migrate } from '@reachinbox/db';
import { getConfig } from '@reachinbox/core';

const config = getConfig();
const db = createPool(config.database.url, 2);
try {
  const applied = await migrate(db);
  console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Database schema is up to date.');
} finally {
  await db.end();
}
