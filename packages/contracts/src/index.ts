import { z } from 'zod';

// ---------------------------------------------------------------------------
// Status vocabulary (mirrors the CHECK constraints in packages/db/migrations)
// ---------------------------------------------------------------------------
export const EMAIL_STATUSES = [
  'SCHEDULED',
  'DEFERRED',
  'SENDING',
  'SENT',
  'FAILED',
  'DELIVERY_UNCERTAIN',
] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

/** Pending or in-progress emails shown in the Scheduled view. */
export const SCHEDULED_VIEW_STATUSES: readonly EmailStatus[] = ['SCHEDULED', 'DEFERRED', 'SENDING'];
/** Settled outcomes shown in the Sent view. Distinct labels are rendered by the UI. */
export const SENT_VIEW_STATUSES: readonly EmailStatus[] = ['SENT', 'FAILED', 'DELIVERY_UNCERTAIN'];

export const VIEWS = ['scheduled', 'sent'] as const;
export type EmailView = (typeof VIEWS)[number];

export const SLACK_STATUSES = ['CONNECTED', 'DISCONNECTED'] as const;
export type SlackInstallationStatus = (typeof SLACK_STATUSES)[number];

export const RATE_SCOPES = ['SENDER', 'CAMPAIGN'] as const;
export type RateScope = (typeof RATE_SCOPES)[number];

// ---------------------------------------------------------------------------
// Limits (defaults; the API also reads MAX_RECIPIENTS_PER_CAMPAIGN from config)
// ---------------------------------------------------------------------------
export const LIMITS = {
  subjectMax: 300,
  bodyMax: 20_000,
  recipientsHardMax: 10_000,
  gapSecondsMax: 24 * 60 * 60,
  hourlyCapMax: 10_000,
  pageSizeDefault: 50,
  pageSizeMax: 100,
  searchQueryMax: 200,
} as const;

// ---------------------------------------------------------------------------
// Recipient normalisation (shared by browser feedback and API revalidation)
// ---------------------------------------------------------------------------
const EMAIL_RE = /^[^\s@,;<>()[\]\\"]+@[^\s@,;<>()[\]\\"]+\.[^\s@,;<>()[\]\\"]{2,}$/;

export type RecipientCheck =
  | { ok: true; value: string }
  | { ok: false; reason: 'EMPTY' | 'INVALID_FORMAT' | 'TOO_LONG' };

/**
 * Conservative normalisation: trim, strip a UTF-8 BOM, lowercase only the domain.
 * The local part keeps its case (local-part case sensitivity is treated as significant), so
 * deduplication is exact on the normalised string. This is documented in the README.
 */
export function normalizeRecipient(raw: string): RecipientCheck {
  const trimmed = raw.replace(/^\uFEFF/, '').trim();
  if (trimmed.length === 0) return { ok: false, reason: 'EMPTY' };
  if (trimmed.length > 254) return { ok: false, reason: 'TOO_LONG' };
  const at = trimmed.lastIndexOf('@');
  if (at <= 0) return { ok: false, reason: 'INVALID_FORMAT' };
  const value = `${trimmed.slice(0, at)}@${trimmed.slice(at + 1).toLowerCase()}`;
  if (!EMAIL_RE.test(value)) return { ok: false, reason: 'INVALID_FORMAT' };
  return { ok: true, value };
}

export interface RecipientReport {
  total: number;
  valid: number;
  invalid: number;
  duplicates: number;
  unique: string[];
}

/** Builds valid/invalid/duplicate counts for a list of raw recipient strings. */
export function analyzeRecipients(rawList: readonly string[]): RecipientReport {
  const seen = new Set<string>();
  const unique: string[] = [];
  let invalid = 0;
  let duplicates = 0;
  for (const raw of rawList) {
    const check = normalizeRecipient(raw);
    if (!check.ok) {
      if (raw.trim().length > 0) invalid += 1;
      continue;
    }
    if (seen.has(check.value)) {
      duplicates += 1;
      continue;
    }
    seen.add(check.value);
    unique.push(check.value);
  }
  return {
    total: rawList.length,
    valid: unique.length,
    invalid,
    duplicates,
    unique,
  };
}

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------
export const isoUtcInstant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/, 'Must be a UTC ISO-8601 instant ending in Z')
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Not a valid date');

export const createCampaignBodySchema = z
  .object({
    senderId: z.uuid(),
    subject: z.string().trim().min(1, 'Subject is required').max(LIMITS.subjectMax),
    body: z.string().min(1, 'Body is required').max(LIMITS.bodyMax, 'Body is too long'),
    startAt: isoUtcInstant,
    gapSeconds: z.number().int().min(0).max(LIMITS.gapSecondsMax),
    hourlyCap: z.number().int().min(1).max(LIMITS.hourlyCapMax),
    recipients: z
      .array(z.string())
      .min(1, 'At least one valid recipient is required')
      .max(LIMITS.recipientsHardMax, 'Too many recipients for one campaign'),
  })
  .strict();
export type CreateCampaignBody = z.infer<typeof createCampaignBodySchema>;

export const emailsListQuerySchema = z.object({
  view: z.enum(VIEWS),
  cursor: z.string().max(1024).optional(),
  senderId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.pageSizeMax).default(LIMITS.pageSizeDefault),
});
export type EmailsListQuery = z.infer<typeof emailsListQuerySchema>;

export const emailsSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(LIMITS.searchQueryMax),
  view: z.enum(VIEWS),
  cursor: z.string().max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.pageSizeMax).default(LIMITS.pageSizeDefault),
});
export type EmailsSearchQuery = z.infer<typeof emailsSearchQuerySchema>;

// ---------------------------------------------------------------------------
// Response DTOs
// ---------------------------------------------------------------------------
export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: unknown;
    correlationId: string;
  };
}

export interface MeResponse {
  user: { id: string; email: string; name: string | null; pictureUrl: string | null };
  workspace: { id: string; name: string };
  csrfToken: string;
  isOperator: boolean;
}

export interface SenderDto {
  id: string;
  label: string;
  fromAddress: string;
  hourlyCap: number;
  minGapMs: number;
  sentThisHour: number;
  nextAllowedAt: string;
}

export interface CampaignCreatedDto {
  campaignId: string;
  status: 'ACCEPTED';
  acceptedCount: number;
  duplicateCount: number;
  replayed: boolean;
  enqueue: { published: number; total: number };
  links: { campaign: string };
}

export interface CampaignProgressDto {
  id: string;
  subject: string;
  senderId: string;
  startAt: string;
  gapSeconds: number;
  hourlyCap: number;
  recipientCount: number;
  counts: Record<EmailStatus, number>;
  enqueue: { published: number; total: number };
  createdAt: string;
}

export interface EmailRowDto {
  id: string;
  campaignId: string;
  senderId: string;
  senderLabel: string;
  recipient: string;
  subject: string;
  sequence: number;
  status: EmailStatus;
  scheduledAt: string;
  nextAttemptAt: string | null;
  sentAt: string | null;
  deferralReason: string | null;
  lastError: string | null;
  previewUrl: string | null;
  messageId: string | null;
  version: number;
}

export interface EmailsPageDto {
  items: EmailRowDto[];
  nextCursor: string | null;
}

export interface SearchHitDto extends EmailRowDto {
  score: number | null;
}

export interface SearchPageDto {
  items: SearchHitDto[];
  nextCursor: string | null;
}

export interface SlackStatusDto {
  configured: boolean;
  status: SlackInstallationStatus | 'NOT_CONNECTED';
  teamName: string | null;
  channelName: string | null;
  connectedAt: string | null;
}

export interface RateLimitEventDto {
  id: string;
  scope: RateScope;
  senderLabel: string;
  campaignId: string | null;
  hour: string;
  cap: number;
  reachedAt: string;
  nextWindowAt: string;
  slackStatus: string;
  slackHttpStatus: number | null;
}

export interface HealthDto {
  status: 'ok' | 'degraded' | 'down';
  checks: Record<string, { ok: boolean; detail?: string }>;
}
