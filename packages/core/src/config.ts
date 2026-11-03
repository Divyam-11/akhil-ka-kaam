import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  ELASTICSEARCH_URL: z.string().default('http://localhost:9200'),
  ELASTICSEARCH_INDEX: z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/).default('emails-v1'),

  APP_PUBLIC_URL: z.string().url().default('http://localhost:5173'),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(12),
  SESSION_COOKIE_SECURE: bool,
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),

  ENCRYPTION_KEY: z
    .string()
    .refine((v) => {
      try {
        return Buffer.from(v, 'base64').length === 32;
      } catch {
        return false;
      }
    }, 'ENCRYPTION_KEY must be 32 bytes encoded as base64'),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OIDC_ISSUER: z.string().url().default('https://accounts.google.com'),
  OPERATOR_EMAILS: z.string().default(''),

  SLACK_CLIENT_ID: z.string().optional(),
  SLACK_CLIENT_SECRET: z.string().optional(),

  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(5),
  MIN_SEND_DELAY_MS: z.coerce.number().int().min(0).max(3_600_000).default(2000),
  MAX_EMAILS_PER_HOUR_PER_SENDER: z.coerce.number().int().min(1).max(1_000_000).default(200),
  SENDER_COUNT: z.coerce.number().int().min(1).max(20).default(2),
  SMTP_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(500).max(120_000).default(10_000),
  SMTP_GREETING_TIMEOUT_MS: z.coerce.number().int().min(500).max(120_000).default(10_000),
  SMTP_SOCKET_TIMEOUT_MS: z.coerce.number().int().min(500).max(300_000).default(20_000),

  MAX_RECIPIENTS_PER_CAMPAIGN: z.coerce.number().int().min(1).max(10_000).default(10_000),
  MAX_JSON_BODY_BYTES: z.coerce.number().int().min(1024).max(50_000_000).default(5_242_880),
  DISPATCHER_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(200),
  OUTBOX_LEASE_MS: z.coerce.number().int().min(1000).max(600_000).default(30_000),
});

export type AppConfig = ReturnType<typeof parseConfig>;

export function parseConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${problems}`);
  }
  const e = parsed.data;
  const operatorEmails = e.OPERATOR_EMAILS.split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return {
    env: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    database: { url: e.DATABASE_URL },
    redis: { url: e.REDIS_URL },
    elasticsearch: { url: e.ELASTICSEARCH_URL, index: e.ELASTICSEARCH_INDEX },
    http: {
      appPublicUrl: e.APP_PUBLIC_URL.replace(/\/$/, ''),
      webOrigin: e.WEB_ORIGIN.replace(/\/$/, ''),
      port: e.API_PORT,
      cookieSecure: e.SESSION_COOKIE_SECURE,
      maxJsonBytes: e.MAX_JSON_BODY_BYTES,
    },
    session: { secret: e.SESSION_SECRET, ttlHours: e.SESSION_TTL_HOURS },
    crypto: { key: Buffer.from(e.ENCRYPTION_KEY, 'base64') },
    google: {
      clientId: e.GOOGLE_CLIENT_ID ?? '',
      clientSecret: e.GOOGLE_CLIENT_SECRET ?? '',
      issuer: e.GOOGLE_OIDC_ISSUER,
      configured: Boolean(e.GOOGLE_CLIENT_ID && e.GOOGLE_CLIENT_SECRET),
    },
    slack: {
      clientId: e.SLACK_CLIENT_ID ?? '',
      clientSecret: e.SLACK_CLIENT_SECRET ?? '',
      configured: Boolean(e.SLACK_CLIENT_ID && e.SLACK_CLIENT_SECRET),
    },
    operatorEmails,
    sending: {
      workerConcurrency: e.WORKER_CONCURRENCY,
      minSendDelayMs: e.MIN_SEND_DELAY_MS,
      maxEmailsPerHourPerSender: e.MAX_EMAILS_PER_HOUR_PER_SENDER,
      senderCount: e.SENDER_COUNT,
      smtp: {
        connectionTimeoutMs: e.SMTP_CONNECTION_TIMEOUT_MS,
        greetingTimeoutMs: e.SMTP_GREETING_TIMEOUT_MS,
        socketTimeoutMs: e.SMTP_SOCKET_TIMEOUT_MS,
      },
    },
    limits: {
      maxRecipientsPerCampaign: e.MAX_RECIPIENTS_PER_CAMPAIGN,
    },
    dispatcher: {
      batchSize: e.DISPATCHER_BATCH_SIZE,
      leaseMs: e.OUTBOX_LEASE_MS,
    },
  };
}

export type Config = AppConfig;

let cached: Config | undefined;
/** Loads and caches configuration from process.env. Throws with every invalid key listed. */
export function getConfig(): Config {
  if (!cached) {
    // Load the repository .env if present. Variables already set in the environment win.
    try {
      process.loadEnvFile(process.env.ENV_FILE ?? '.env');
    } catch {
      // No file: rely on the process environment alone.
    }
    cached = parseConfig(process.env);
  }
  return cached;
}

/** Test helper: forget the cached config so a test can supply different environment values. */
export function resetConfigCache(): void {
  cached = undefined;
}
