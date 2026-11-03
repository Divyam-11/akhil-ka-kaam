import { createPool } from '@reachinbox/db';
import { encryptSecret, getConfig } from '@reachinbox/core';

/**
 * OFFLINE FALLBACK ONLY. Points sender_pool entries at a local SMTP sink (pnpm dev:smtp-sink,
 * port 2525) so the pipeline can be exercised without network access to Ethereal.
 * Messages are accepted by the sink and are NOT delivered anywhere. The Ethereal integration is
 * `pnpm seed:ethereal`, which is the path used for the submission demo.
 */
const config = getConfig();
const port = Number(process.env.SINK_PORT ?? 2525);
const db = createPool(config.database.url, 2);
try {
  for (let i = 1; i <= config.sending.senderCount; i += 1) {
    const label = `Local sink sender ${i}`;
    const secret = JSON.stringify({ host: '127.0.0.1', port, secure: false, user: 'sink', pass: 'sink' });
    await db.query(
      `INSERT INTO sender_pool (label, from_address, smtp_config_encrypted)
       VALUES ($1, $2, $3) ON CONFLICT (label) DO NOTHING`,
      [label, `sink${i}@local.test`, encryptSecret(secret, config.crypto.key)],
    );
  }
  console.log(`Local sink senders ready on 127.0.0.1:${port} (offline fallback; not Ethereal).`);
} finally {
  await db.end();
}
