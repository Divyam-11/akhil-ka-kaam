import pino from 'pino';

/**
 * Structured logger. Redacts credentials and cookie material defensively; code must still avoid
 * logging email bodies, recipient lists, webhook URLs or SMTP secrets in the first place.
 */
export function createLogger(name: string, level: string = 'info') {
  return pino({
    name,
    level,
    base: { service: name },
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        'res.headers["set-cookie"]',
        '*.password',
        '*.pass',
        '*.secret',
        '*.token',
        '*.webhookUrl',
        '*.smtp_config_encrypted',
      ],
      censor: '[redacted]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type Logger = ReturnType<typeof createLogger>;
