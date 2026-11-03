import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { ApiErrorEnvelope } from '@reachinbox/contracts';
import type { Logger } from '@reachinbox/core';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function correlationId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  const id = incoming && /^[A-Za-z0-9._-]{8,100}$/.test(incoming) ? incoming : randomUUID();
  res.locals.correlationId = id;
  res.setHeader('X-Request-Id', id);
  next();
}

/** Access log without query strings (search text and cursors are never logged). */
export function accessLog(logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const started = Date.now();
    res.on('finish', () => {
      if (req.path === '/health/live') return;
      logger.info(
        {
          correlationId: res.locals.correlationId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          ms: Date.now() - started,
        },
        'request',
      );
    });
    next();
  };
}

export function notFoundHandler(req: Request, res: Response): void {
  const body: ApiErrorEnvelope = {
    error: { code: 'NOT_FOUND', message: 'No such route', correlationId: String(res.locals.correlationId) },
  };
  res.status(404).json(body);
}

export function errorHandler(logger: Logger) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    const cid = String(res.locals.correlationId ?? '');
    if (err instanceof ApiError) {
      const body: ApiErrorEnvelope = {
        error: { code: err.code, message: err.message, details: err.details, correlationId: cid },
      };
      res.status(err.status).json(body);
      return;
    }
    const e = err as { type?: string; status?: number; name?: string };
    if (e?.type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large', correlationId: cid } });
      return;
    }
    if (e?.type === 'entity.parse.failed' || e?.name === 'SyntaxError') {
      res.status(400).json({ error: { code: 'MALFORMED_JSON', message: 'Request body is not valid JSON', correlationId: cid } });
      return;
    }
    logger.error({ correlationId: cid, path: req.path, err: String((err as Error)?.message ?? err) }, 'unhandled error');
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong', correlationId: cid } });
  };
}
