import nodemailer from 'nodemailer';
import { createPool, withTransaction } from '@reachinbox/db';
import { encryptSecret, getConfig } from '@reachinbox/core';
import { provisionSenders } from '../apps/api/src/services/workspace.js';

/**
 * Provisions Ethereal SMTP sender accounts once and stores them encrypted in sender_pool.
 *   - Creates accounts only while the pool holds fewer than SENDER_COUNT entries (never regenerates).
 *   - Syncs the protective caps from env onto every existing sender row (idempotent).
 *   - Copies missing pool senders into every workspace.
 * Credentials are never printed.
 */
const config = getConfig();
const db = createPool(config.database.url, 2);

try {
  const existing = Number(
    (await db.query<{ n: string }>('SELECT count(*)::text AS n FROM sender_pool')).rows[0]!.n,
  );
  const needed = Math.max(0, config.sending.senderCount - existing);
  if (needed === 0) {
    console.log(`Pool already has ${existing} sender account(s); nothing to create.`);
  }
  for (let i = 0; i < needed; i += 1) {
    const account = await nodemailer.createTestAccount();
    const label = `Ethereal sender ${existing + i + 1}`;
    const secret = JSON.stringify({
      host: account.smtp.host,
      port: account.smtp.port,
      secure: account.smtp.secure,
      user: account.user,
      pass: account.pass,
    });
    await db.query(
      `INSERT INTO sender_pool (label, from_address, smtp_config_encrypted) VALUES ($1, $2, $3)`,
      [label, account.user, encryptSecret(secret, config.crypto.key)],
    );
    console.log(`Created ${label} (${account.user}).`);
  }

  await withTransaction(db, async (tx) => {
    const sync = await tx.query(
      'UPDATE senders SET hourly_cap = $1, min_gap_ms = $2 WHERE hourly_cap <> $1 OR min_gap_ms <> $2',
      [config.sending.maxEmailsPerHourPerSender, config.sending.minSendDelayMs],
    );
    const workspaces = await tx.query<{ id: string }>('SELECT id FROM workspaces');
    let copied = 0;
    for (const ws of workspaces.rows) copied += await provisionSenders(tx, ws.id, config);
    console.log(
      `Caps synced on ${sync.rowCount ?? 0} sender row(s); ${copied} sender(s) copied into ${workspaces.rowCount} workspace(s).`,
    );
  });
  const total = await db.query('SELECT label, from_address FROM sender_pool ORDER BY label');
  for (const row of total.rows) console.log(`  ${row.label}: ${row.from_address}`);
} finally {
  await db.end();
}
