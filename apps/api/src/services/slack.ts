import type { Db, Tx } from '@reachinbox/db';
import { encryptSecret, decryptSecret, revokeSlackToken, type Config, type SlackInstallation } from '@reachinbox/core';
import type { SlackStatusDto } from '@reachinbox/contracts';

export async function getSlackStatus(db: Db, config: Config, workspaceId: string): Promise<SlackStatusDto> {
  const r = (
    await db.query(
      `SELECT status, team_name, channel_name, connected_at FROM slack_installations WHERE workspace_id = $1`,
      [workspaceId],
    )
  ).rows[0];
  return {
    configured: config.slack.configured,
    status: r ? r.status : 'NOT_CONNECTED',
    teamName: r?.team_name ?? null,
    channelName: r?.channel_name ?? null,
    connectedAt: r?.connected_at ? new Date(r.connected_at).toISOString() : null,
  };
}

/** Stores the installation. Replacing an existing one bumps the generation so in-flight checks see it. */
export async function saveInstallation(tx: Tx, config: Config, workspaceId: string, inst: SlackInstallation): Promise<void> {
  const key = config.crypto.key;
  await tx.query(
    `INSERT INTO slack_installations
       (workspace_id, status, generation, team_id, team_name, channel_id, channel_name,
        webhook_url_encrypted, access_token_encrypted, connected_at, updated_at)
     VALUES ($1, 'CONNECTED', 1, $2, $3, $4, $5, $6, $7, now(), now())
     ON CONFLICT (workspace_id) DO UPDATE SET
       status = 'CONNECTED',
       generation = slack_installations.generation + 1,
       team_id = EXCLUDED.team_id,
       team_name = EXCLUDED.team_name,
       channel_id = EXCLUDED.channel_id,
       channel_name = EXCLUDED.channel_name,
       webhook_url_encrypted = EXCLUDED.webhook_url_encrypted,
       access_token_encrypted = EXCLUDED.access_token_encrypted,
       connected_at = now(),
       disconnected_at = NULL,
       updated_at = now()`,
    [
      workspaceId,
      inst.teamId,
      inst.teamName,
      inst.channelId,
      inst.channelName,
      encryptSecret(inst.webhookUrl, key),
      inst.accessToken ? encryptSecret(inst.accessToken, key) : null,
    ],
  );
}

/**
 * Disconnect takes effect locally at once: the status flips, the generation bumps and the stored
 * secrets are cleared. A retained token is revoked best-effort. The remote incoming webhook is not
 * revoked by Slack's API here, so it stays valid until it is removed in Slack (documented).
 */
export async function disconnectSlack(db: Db, config: Config, workspaceId: string): Promise<{ tokenRevoked: boolean | null }> {
  const row = (
    await db.query(
      'SELECT access_token_encrypted FROM slack_installations WHERE workspace_id = $1 AND status = $2',
      [workspaceId, 'CONNECTED'],
    )
  ).rows[0];
  let tokenRevoked: boolean | null = null;
  if (row?.access_token_encrypted) {
    tokenRevoked = await revokeSlackToken(decryptSecret(row.access_token_encrypted, config.crypto.key));
  }
  await db.query(
    `UPDATE slack_installations
        SET status = 'DISCONNECTED', generation = generation + 1, disconnected_at = now(),
            webhook_url_encrypted = NULL, access_token_encrypted = NULL, updated_at = now()
      WHERE workspace_id = $1`,
    [workspaceId],
  );
  return { tokenRevoked };
}
