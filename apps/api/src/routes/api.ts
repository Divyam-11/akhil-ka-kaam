import { Router, type Request, type Response } from 'express';
import type { Client as EsClient } from '@elastic/elasticsearch';
import type { Db } from '@reachinbox/db';
import {
  createCampaignBodySchema,
  emailsListQuerySchema,
  emailsSearchQuerySchema,
  LIMITS,
  type MeResponse,
  type RateLimitEventDto,
  type SenderDto,
} from '@reachinbox/contracts';
import type { ZodType } from 'zod';
import {
  searchEmails,
  utcHourStart,
  type Clock,
  type Config,
  type QueueSet,
  type Logger,
} from '@reachinbox/core';
import { ApiError } from '../http/errors.js';
import { requireAuth, requireCsrf } from '../http/session.js';
import { createCampaign, getCampaignProgress } from '../services/campaigns.js';
import { getEmailDetail, listEmails } from '../services/emails.js';
import { disconnectSlack, getSlackStatus } from '../services/slack.js';

export interface ApiRouteDeps {
  db: Db;
  config: Config;
  es: EsClient;
  clock: Clock;
  logger: Logger;
  queues: QueueSet;
}

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,200}$/;

function parse<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ApiError(422, 'VALIDATION_FAILED', 'Some fields are invalid', {
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}

export function createApiRouter(deps: ApiRouteDeps): Router {
  const { db, config, es, clock } = deps;
  const router = Router();

  // Every route below requires a session; CSRF is enforced for mutations.
  router.use(requireCsrf(config));
  router.use(requireAuth);

  router.get('/me', (req: Request, res: Response) => {
    const a = req.auth!;
    const body: MeResponse = {
      user: { id: a.userId, email: a.email, name: a.name, pictureUrl: a.pictureUrl },
      workspace: { id: a.workspaceId, name: a.workspaceName },
      csrfToken: a.csrfToken,
      isOperator: a.isOperator,
    };
    res.json(body);
  });

  router.get('/senders', async (req: Request, res: Response) => {
    const hour = utcHourStart(clock.now());
    const r = await db.query(
      `SELECT s.id, s.label, s.from_address, s.hourly_cap, s.min_gap_ms, s.next_allowed_at,
              COALESCE(h.attempt_count, 0) AS sent_this_hour
         FROM senders s
         LEFT JOIN hourly_usage h
           ON h.scope_type = 'SENDER' AND h.scope_id = s.id AND h.hour = $2
        WHERE s.workspace_id = $1
        ORDER BY s.label`,
      [req.auth!.workspaceId, hour],
    );
    const items: SenderDto[] = r.rows.map((s) => ({
      id: s.id,
      label: s.label,
      fromAddress: s.from_address,
      hourlyCap: s.hourly_cap,
      minGapMs: s.min_gap_ms,
      sentThisHour: Number(s.sent_this_hour),
      nextAllowedAt: new Date(s.next_allowed_at).toISOString(),
    }));
    res.json({ items, window: { startsAt: hour.toISOString() } });
  });

  router.post('/campaigns', async (req: Request, res: Response) => {
    const key = req.header('idempotency-key') ?? '';
    if (!IDEMPOTENCY_KEY_RE.test(key)) {
      throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'An Idempotency-Key header (8-200 safe characters) is required');
    }
    const body = parse(createCampaignBodySchema, req.body);
    if (body.recipients.length > config.limits.maxRecipientsPerCampaign) {
      throw new ApiError(422, 'TOO_MANY_RECIPIENTS', `A campaign may contain at most ${config.limits.maxRecipientsPerCampaign} recipients`);
    }
    const dto = await createCampaign(db, config, { workspaceId: req.auth!.workspaceId }, key, body);
    // Queue publication happens asynchronously via the outbox; `enqueue` reports it honestly.
    res.status(202).json(dto);
  });

  router.get('/campaigns/:id', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError(404, 'NOT_FOUND', 'Campaign not found');
    const dto = await getCampaignProgress(db, req.auth!.workspaceId, id);
    if (!dto) throw new ApiError(404, 'NOT_FOUND', 'Campaign not found');
    res.json(dto);
  });

  router.get('/emails', async (req: Request, res: Response) => {
    const q = parse(emailsListQuerySchema, req.query);
    const page = await listEmails(db, {
      workspaceId: req.auth!.workspaceId,
      view: q.view,
      limit: q.limit,
      cursor: q.cursor,
      senderId: q.senderId,
    });
    res.json(page);
  });

  // Declared before "/emails/:id" so "search" is not treated as an id.
  router.get('/emails/search', async (req: Request, res: Response) => {
    const q = parse(emailsSearchQuerySchema, req.query);
    if (q.q.length > LIMITS.searchQueryMax) throw new ApiError(422, 'VALIDATION_FAILED', 'Search text is too long');
    try {
      const result = await searchEmails(es, {
        workspaceId: req.auth!.workspaceId,
        view: q.view,
        q: q.q,
        limit: q.limit,
        cursor: q.cursor ?? null,
        index: config.elasticsearch.index,
      });
      res.json(result);
    } catch (error) {
      deps.logger.warn({ err: String((error as Error).message), correlationId: res.locals.correlationId }, 'search failed');
      throw new ApiError(
        503,
        'SEARCH_UNAVAILABLE',
        'Search is temporarily unavailable. Scheduled and sent lists still work, and delivery is unaffected.',
      );
    }
  });

  router.get('/emails/:id', async (req: Request, res: Response) => {
    const id = String(req.params.id);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError(404, 'NOT_FOUND', 'Email not found');
    const detail = await getEmailDetail(db, req.auth!.workspaceId, id);
    if (!detail) throw new ApiError(404, 'NOT_FOUND', 'Email not found');
    res.json(detail);
  });

  router.get('/rate-limit-events', async (req: Request, res: Response) => {
    const r = await db.query(
      `SELECT e.id, e.scope_type, s.label AS sender_label, e.campaign_id, e.hour, e.cap,
              e.reached_at, e.next_window_at, e.slack_status, e.slack_http_status
         FROM rate_limit_events e
         JOIN senders s ON s.id = e.sender_id
        WHERE e.workspace_id = $1
        ORDER BY e.created_at DESC
        LIMIT 20`,
      [req.auth!.workspaceId],
    );
    const items: RateLimitEventDto[] = r.rows.map((e) => ({
      id: e.id,
      scope: e.scope_type,
      senderLabel: e.sender_label,
      campaignId: e.campaign_id,
      hour: new Date(e.hour).toISOString(),
      cap: e.cap,
      reachedAt: new Date(e.reached_at).toISOString(),
      nextWindowAt: new Date(e.next_window_at).toISOString(),
      slackStatus: e.slack_status,
      slackHttpStatus: e.slack_http_status,
    }));
    res.json({ items });
  });

  router.get('/integrations/slack', async (req: Request, res: Response) => {
    res.json(await getSlackStatus(db, config, req.auth!.workspaceId));
  });

  router.delete('/integrations/slack', async (req: Request, res: Response) => {
    const result = await disconnectSlack(db, config, req.auth!.workspaceId);
    res.json({ status: 'DISCONNECTED', ...result });
  });

  return router;
}

