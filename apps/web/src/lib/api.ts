import type {
  CampaignCreatedDto,
  CreateCampaignBody,
  EmailRowDto,
  EmailsPageDto,
  EmailView,
  MeResponse,
  RateLimitEventDto,
  SearchPageDto,
  SenderDto,
  SlackStatusDto,
} from '@reachinbox/contracts';

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly correlationId?: string,
  ) {
    super(message);
  }
}

/** The CSRF token is delivered by GET /api/me and attached to every mutation. */
let csrfToken: string | null = null;
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
}

async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const url = new URL(path, window.location.origin);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = { Accept: 'application/json', ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => null)) as
    | { error?: { code?: string; message?: string; details?: unknown; correlationId?: string } }
    | T
    | null;
  if (!res.ok) {
    const err = (json as { error?: { code?: string; message?: string; details?: unknown; correlationId?: string } } | null)?.error;
    throw new ApiClientError(
      res.status,
      err?.code ?? 'HTTP_ERROR',
      err?.message ?? `Request failed with status ${res.status}`,
      err?.details,
      err?.correlationId,
    );
  }
  return json as T;
}

export const api = {
  me: () => request<MeResponse>('GET', '/api/me'),
  senders: () => request<{ items: SenderDto[] }>('GET', '/api/senders'),
  createCampaign: (body: CreateCampaignBody, idempotencyKey: string) =>
    request<CampaignCreatedDto>('POST', '/api/campaigns', { body, headers: { 'Idempotency-Key': idempotencyKey } }),
  listEmails: (view: EmailView, cursor?: string, senderId?: string) =>
    request<EmailsPageDto>('GET', '/api/emails', { query: { view, cursor, senderId, limit: 25 } }),
  search: (q: string, view: EmailView, cursor?: string) =>
    request<SearchPageDto>('GET', '/api/emails/search', { query: { q, view, cursor, limit: 25 } }),
  email: (id: string) => request<EmailRowDto & { attempt: { status: string; startedAt: string; finishedAt: string | null; errorClass: string | null } | null }>('GET', `/api/emails/${id}`),
  rateEvents: () => request<{ items: RateLimitEventDto[] }>('GET', '/api/rate-limit-events'),
  slack: () => request<SlackStatusDto>('GET', '/api/integrations/slack'),
  disconnectSlack: () => request<{ status: string }>('DELETE', '/api/integrations/slack'),
  logout: () => request<void>('POST', '/auth/logout'),
};
