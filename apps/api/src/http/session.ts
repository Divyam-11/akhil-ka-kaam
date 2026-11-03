import type { NextFunction, Request, Response } from 'express';
import type { Db } from '@reachinbox/db';
import { constantTimeEqual, hashToken, type Config } from '@reachinbox/core';
import { ApiError } from './errors.js';

export const SESSION_COOKIE = 'ri_session';

export interface AuthContext {
  userId: string;
  email: string;
  name: string | null;
  pictureUrl: string | null;
  workspaceId: string;
  workspaceName: string;
  csrfToken: string;
  isOperator: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export function setSessionCookie(res: Response, token: string, config: Config, maxAgeMs: number): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.http.cookieSecure,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeMs,
  });
}

export function clearSessionCookie(res: Response, config: Config): void {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: config.http.cookieSecure, sameSite: 'lax', path: '/' });
}

/** Resolves the session cookie to an auth context. Unknown or expired sessions are simply anonymous. */
export function loadSession(deps: { db: Db; config: Config }) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const token = readCookie(req.headers.cookie, SESSION_COOKIE);
      if (!token) return next();
      const row = (
        await deps.db.query(
          `SELECT u.id AS user_id, u.email, u.name, u.picture_url, s.csrf_token,
                  w.id AS workspace_id, w.name AS workspace_name
             FROM sessions s
             JOIN users u ON u.id = s.user_id
             JOIN workspaces w ON w.owner_user_id = u.id
            WHERE s.token_hash = $1 AND s.expires_at > now()`,
          [hashToken(token, deps.config.session.secret)],
        )
      ).rows[0];
      if (row) {
        req.auth = {
          userId: row.user_id,
          email: row.email,
          name: row.name,
          pictureUrl: row.picture_url,
          workspaceId: row.workspace_id,
          workspaceName: row.workspace_name,
          csrfToken: row.csrf_token,
          isOperator: deps.config.operatorEmails.includes(String(row.email).toLowerCase()),
        };
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.auth) return next(new ApiError(401, 'UNAUTHENTICATED', 'Sign in with Google to continue'));
  next();
}

export function requireOperator(req: Request, _res: Response, next: NextFunction): void {
  if (!req.auth) return next(new ApiError(401, 'UNAUTHENTICATED', 'Sign in with Google to continue'));
  if (!req.auth.isOperator) return next(new ApiError(403, 'FORBIDDEN', 'Operator access required'));
  next();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for session-authenticated mutations: the request must carry the session's
 * synchronizer token in a custom header, and any Origin header must be the configured web origin.
 * Cookies are SameSite=Lax, which is the second layer.
 */
export function requireCsrf(config: Config) {
  const allowedOrigins = new Set([config.http.webOrigin, config.http.appPublicUrl]);
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(req.method)) return next();
    const origin = req.header('origin');
    if (origin && !allowedOrigins.has(origin.replace(/\/$/, ''))) {
      return next(new ApiError(403, 'BAD_ORIGIN', 'Request origin is not allowed'));
    }
    const sent = req.header('x-csrf-token');
    if (!req.auth || !sent || !constantTimeEqual(sent, req.auth.csrfToken)) {
      return next(new ApiError(403, 'CSRF_REJECTED', 'Missing or invalid CSRF token'));
    }
    next();
  };
}
