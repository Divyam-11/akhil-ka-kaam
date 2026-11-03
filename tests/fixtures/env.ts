// Test-only environment. Loaded before config is first read (vitest setupFiles).
// Values here are fixed test secrets; they never reach production configuration.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'error';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://reachinbox:reachinbox@localhost:5432/reachinbox_test';
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1';
process.env.ELASTICSEARCH_URL = process.env.TEST_ELASTICSEARCH_URL ?? 'http://localhost:9200';
process.env.ELASTICSEARCH_INDEX = 'emails-test';
process.env.APP_PUBLIC_URL = 'http://localhost:5173';
process.env.WEB_ORIGIN = 'http://localhost:5173';
process.env.SESSION_SECRET = 'test-session-secret-0123456789abcdef';
process.env.ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.OPERATOR_EMAILS = 'operator@test.local';
process.env.MIN_SEND_DELAY_MS = '0';
process.env.MAX_EMAILS_PER_HOUR_PER_SENDER = '10000';
process.env.WORKER_CONCURRENCY = '5';
process.env.SENDER_COUNT = '2';
process.env.SMTP_CONNECTION_TIMEOUT_MS = '5000';
process.env.SMTP_GREETING_TIMEOUT_MS = '5000';
process.env.SMTP_SOCKET_TIMEOUT_MS = '5000';
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.SLACK_CLIENT_ID;
