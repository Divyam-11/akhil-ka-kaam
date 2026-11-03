import { Router, type Request, type Response } from 'express';
import * as oidc from 'openid-client';
import { randomUUID } from 'node:crypto';
import { withTransaction, type Db } from '@reachinbox/db';
import {
  buildSlackAuthorizeUrl,
  exchangeSlackCode,
  hashToken,
  newOpaqueToken,
  sha256Hex,
  SlackOAuthError,
  type Clock,
  type Config,
  type Logger,
} from '@reachinbox/core';
import { ApiError } from '../http/errors.js';
import { clearSessionCookie, requireAuth, requireCsrf, setSessionCookie } from '../http/session.js';
import { ensureUserWorkspace } from '../services/workspace.js';
import { saveInstallation } from '../services/slack.js';

const STATE_TTL_MS = 10 * 60 * 1000;

export interface AuthDeps {
  db: Db;
  config: Config;
  logger: Logger;
  clock: Clock;
}

/** Discovery is fetched once per process and reused; openid-client validates issuer metadata. */
function createOidcConfigLoader(config: Config) {
  let cached: Promise<oidc.Configuration> | undefined;
  return () => {
    cached ??= oidc.discovery(
      new URL(config.google.issuer),
      config.google.clientId,
      undefined,
      oidc.ClientSecretPost(config.google.clientSecret),
    );
    cached.catch(() => {
      cached = undefined;
    });
    return cached;
  };
}

export function createAuthRouter(deps: AuthDeps): Router {
  const { db, config, logger, clock } = deps;
  const router = Router();
  const oidcConfig = createOidcConfigLoader(config);
  const googleRedirect = `${config.http.appPublicUrl}/auth/google/callback`;
  const slackRedirect = `${config.http.appPublicUrl}/auth/slack/callback`;
  const webHome = `${config.http.appPublicUrl}/`;

  // ---------------------------------------------------------------- Google
  router.get('/auth/google', async (_req: Request, res: Response) => {
    if (!config.google.configured) {
      throw new ApiError(503, 'GOOGLE_NOT_CONFIGURED', 'Google sign-in is not configured on this server');
    }
    const cfg = await oidcConfig();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    await db.query(
      `INSERT INTO oauth_states (state_hash, kind, payload, expires_at)
       VALUES ($1, 'google', $2, $3)`,
      [sha256Hex(state), { codeVerifier, nonce }, new Date(clock.now().getTime() + STATE_TTL_MS)],
    );
    const url = oidc.buildAuthorizationUrl(cfg, {
      redirect_uri: googleRedirect,
      scope: 'openid email profile',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce,
      prompt: 'select_account',
    });
    res.redirect(url.toString());
  });

  router.get('/auth/google/callback', async (req: Request, res: Response) => {
    if (typeof req.query.error === 'string') {
      res.redirect(`${webHome}?auth=denied`);
      return;
    }
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const row = (
      await db.query(
        `DELETE FROM oauth_states
          WHERE state_hash = $1 AND kind = 'google' AND expires_at > now()
          RETURNING payload`,
        [sha256Hex(state)],
      )
    ).rows[0];
    if (!row) {
      res.redirect(`${webHome}?auth=expired`);
      return;
    }
    try {
      const cfg = await oidcConfig();
      const currentUrl = new URL(req.originalUrl, config.http.appPublicUrl);
      const tokens = await oidc.authorizationCodeGrant(
        cfg,
        currentUrl,
        {
          pkceCodeVerifier: row.payload.codeVerifier,
          expectedState: state,
          expectedNonce: row.payload.nonce,
        },
        new URLSearchParams({ redirect_uri: googleRedirect }),
      );
      const claims = tokens.claims();
      if (!claims || typeof claims.sub !== 'string' || typeof claims.email !== 'string') {
        res.redirect(`${webHome}?auth=invalid_identity`);
        return;
      }
      if (claims.email_verified !== true) {
        res.redirect(`${webHome}?auth=unverified_email`);
        return;
      }
      const ids = await ensureUserWorkspace(db, config, {
        sub: claims.sub,
        email: claims.email,
        name: typeof claims.name === 'string' ? claims.name : null,
        pictureUrl: typeof claims.picture === 'string' ? claims.picture : null,
      });
      const token = newOpaqueToken(32);
      const csrf = newOpaqueToken(24);
      const ttlMs = config.session.ttlHours * 3600 * 1000;
      await db.query(
        `INSERT INTO sessions (token_hash, user_id, csrf_token, expires_at) VALUES ($1, $2, $3, $4)`,
        [hashToken(token, config.session.secret), ids.userId, csrf, new Date(clock.now().getTime() + ttlMs)],
      );
      setSessionCookie(res, token, config, ttlMs);
      logger.info({ userId: ids.userId }, 'user signed in');
      res.redirect(webHome);
    } catch (error) {
      logger.warn({ err: String((error as Error).message) }, 'google sign-in failed');
      res.redirect(`${webHome}?auth=failed`);
    }
  });

  router.post('/auth/logout', requireCsrf(config), requireAuth, async (req: Request, res: Response) => {
    const token = req.headers.cookie
      ?.split(';')
      .map((p) => p.trim())
      .find((p) => p.startsWith('ri_session='))
      ?.slice('ri_session='.length);
    if (token) {
      await db.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(decodeURIComponent(token), config.session.secret)]);
    }
    clearSessionCookie(res, config);
    res.status(204).end();
  });

  // ---------------------------------------------------------------- Slack
  router.get('/auth/slack', requireAuth, async (req: Request, res: Response) => {
    if (!config.slack.configured) {
      res.redirect(`${webHome}?slack=not_configured`);
      return;
    }
    const state = randomUUID() + newOpaqueToken(16);
    await db.query(
      `INSERT INTO oauth_states (state_hash, kind, user_id, payload, expires_at)
       VALUES ($1, 'slack', $2, $3, $4)`,
      [
        sha256Hex(state),
        req.auth!.userId,
        { workspaceId: req.auth!.workspaceId },
        new Date(clock.now().getTime() + STATE_TTL_MS),
      ],
    );
    res.redirect(
      buildSlackAuthorizeUrl({ clientId: config.slack.clientId, redirectUri: slackRedirect, state }),
    );
  });

  router.get('/auth/slack/callback', requireAuth, async (req: Request, res: Response) => {
    if (typeof req.query.error === 'string') {
      res.redirect(`${webHome}?slack=denied`);
      return;
    }
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const row = (
      await db.query(
        `DELETE FROM oauth_states
          WHERE state_hash = $1 AND kind = 'slack' AND expires_at > now()
          RETURNING user_id, payload`,
        [sha256Hex(state)],
      )
    ).rows[0];
    if (!row || !code) {
      res.redirect(`${webHome}?slack=expired`);
      return;
    }
    // The state is bound to the user who started the flow; a different session cannot complete it.
    if (row.user_id !== req.auth!.userId || row.payload.workspaceId !== req.auth!.workspaceId) {
      res.redirect(`${webHome}?slack=session_mismatch`);
      return;
    }
    try {
      const installation = await exchangeSlackCode({
        clientId: config.slack.clientId,
        clientSecret: config.slack.clientSecret,
        code,
        redirectUri: slackRedirect,
      });
      await withTransaction(db, (tx) => saveInstallation(tx, config, req.auth!.workspaceId, installation));
      logger.info({ workspaceId: req.auth!.workspaceId }, 'slack installation saved');
      res.redirect(`${webHome}?slack=connected`);
    } catch (error) {
      const reason = error instanceof SlackOAuthError ? error.code : 'exchange_failed';
      logger.warn({ reason }, 'slack installation failed');
      res.redirect(`${webHome}?slack=error&reason=${encodeURIComponent(reason)}`);
    }
  });

  return router;
}

/** Periodically removes expired sessions and OAuth state rows. */
export async function pruneExpiredAuthRows(db: Db): Promise<void> {
  await db.query('DELETE FROM sessions WHERE expires_at < now()');
  await db.query('DELETE FROM oauth_states WHERE expires_at < now()');
}
