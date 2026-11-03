import type { Db } from '@reachinbox/db';
import { withTransaction } from '@reachinbox/db';
import type { Config } from '@reachinbox/core';

export interface GoogleProfile {
  sub: string;
  email: string;
  name: string | null;
  pictureUrl: string | null;
}

/**
 * Creates or refreshes the user, ensures their single workspace exists and copies the seeded
 * sender pool into it. Idempotent: repeated logins only fill in missing senders.
 */
export async function ensureUserWorkspace(db: Db, config: Config, profile: GoogleProfile): Promise<{ userId: string; workspaceId: string }> {
  return withTransaction(db, async (tx) => {
    const user = (
      await tx.query<{ id: string }>(
        `INSERT INTO users (google_sub, email, name, picture_url)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (google_sub)
         DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name, picture_url = EXCLUDED.picture_url, updated_at = now()
         RETURNING id`,
        [profile.sub, profile.email, profile.name, profile.pictureUrl],
      )
    ).rows[0]!;
    await tx.query(
      `INSERT INTO workspaces (owner_user_id, name)
       VALUES ($1, $2)
       ON CONFLICT (owner_user_id) DO NOTHING`,
      [user.id, `${profile.name ?? profile.email}'s workspace`],
    );
    const ws = (await tx.query<{ id: string }>('SELECT id FROM workspaces WHERE owner_user_id = $1', [user.id])).rows[0]!;
    await provisionSenders(tx, ws.id, config);
    return { userId: user.id, workspaceId: ws.id };
  });
}

/** Copies pool senders into a workspace. Existing rows keep their current caps. */
export async function provisionSenders(
  tx: { query: Db['query'] },
  workspaceId: string,
  config: Config,
): Promise<number> {
  const r = await tx.query(
    `INSERT INTO senders (workspace_id, label, from_address, smtp_config_encrypted, hourly_cap, min_gap_ms)
     SELECT $1, label, from_address, smtp_config_encrypted, $2, $3 FROM sender_pool
     ON CONFLICT (workspace_id, label) DO NOTHING`,
    [workspaceId, config.sending.maxEmailsPerHourPerSender, config.sending.minSendDelayMs],
  );
  return r.rowCount ?? 0;
}
