import { createPool } from '@reachinbox/db';
import { getConfig } from '@reachinbox/core';
import { ensureUserWorkspace } from '../../apps/api/src/services/workspace.js';
import { newOpaqueToken, hashToken } from '@reachinbox/core';

/**
 * LOCAL VERIFICATION HELPER. Creates a server-side session for a given email so a developer can
 * exercise the dashboard against the local stack without completing Google consent. It is not a
 * login route, refuses to run in production, and is not used by the product code path.
 *   pnpm dev:session -- you@example.com
 */
if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to create a development session in production.');
  process.exit(1);
}
const email = process.argv[2];
if (!email) {
  console.error('Usage: pnpm dev:session -- <email>');
  process.exit(1);
}
const config = getConfig();
const db = createPool(config.database.url, 2);
try {
  const ids = await ensureUserWorkspace(db, config, { sub: `local-${email}`, email, name: email.split('@')[0] ?? null, pictureUrl: null });
  const token = newOpaqueToken(32);
  const csrf = newOpaqueToken(24);
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES ($1, $2, $3, now() + make_interval(hours => $4))`,
    [hashToken(token, config.session.secret), ids.userId, csrf, config.session.ttlHours],
  );
  console.log('Session created. Paste this cookie into the browser for http://localhost:5173:');
  console.log(`ri_session=${token}`);
} finally {
  await db.end();
}
