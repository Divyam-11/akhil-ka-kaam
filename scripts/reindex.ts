import { createPool } from '@reachinbox/db';
import { createEsClient, getConfig, reindexAll } from '@reachinbox/core';

/**
 * Rebuilds the search index from PostgreSQL. Elasticsearch is a derived index: this is the recovery
 * path after data loss or a mapping change (create a new index name and point ELASTICSEARCH_INDEX at it).
 */
const config = getConfig();
const db = createPool(config.database.url, 4);
const es = createEsClient(config.elasticsearch.url);
try {
  const total = await reindexAll(db, es, config.elasticsearch.index, 500, (n) => {
    if (n % 5000 === 0) console.log(`indexed ${n}`);
  });
  console.log(`Reindex complete: ${total} email documents in index "${config.elasticsearch.index}".`);
} finally {
  await db.end();
  es.close();
}
