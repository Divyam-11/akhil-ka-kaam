import nodemailer, { type Transporter } from 'nodemailer';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

export interface SmtpTimeouts {
  connectionTimeoutMs: number;
  greetingTimeoutMs: number;
  socketTimeoutMs: number;
}

export type SmtpTransport = Transporter;

/**
 * One transport per sender. Pooling is disabled and nodemailer does not retry a message on its
 * own; every SMTP submission is an explicit, recorded attempt (see delivery/deliver.ts).
 */
export function createSmtpTransport(config: SmtpConfig, timeouts: SmtpTimeouts): SmtpTransport {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.user, pass: config.pass },
    pool: false,
    connectionTimeout: timeouts.connectionTimeoutMs,
    greetingTimeout: timeouts.greetingTimeoutMs,
    socketTimeout: timeouts.socketTimeoutMs,
    disableFileAccess: true,
    disableUrlAccess: true,
    tls: { rejectUnauthorized: true },
  });
}

/** Ethereal preview URL when the account is an Ethereal test account; otherwise null. */
export function previewUrlFor(info: unknown): string | null {
  const url = nodemailer.getTestMessageUrl(info as Parameters<typeof nodemailer.getTestMessageUrl>[0]);
  return typeof url === 'string' ? url : null;
}

export type SmtpFailureClass =
  /** The SMTP server rejected the submission with a reply code (not accepted). */
  | 'REJECTED'
  /** Failed before any message content could have been transferred (connect, DNS, auth). */
  | 'NOT_SENT'
  /** The outcome is unknown: connection or timeout after the transaction may have started. */
  | 'UNCERTAIN';

export interface ClassifiedSmtpError {
  failureClass: SmtpFailureClass;
  /** Short, secret-free description safe to store and display. */
  detail: string;
}

const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EDNS', 'EAUTH', 'EPROTOCOL_TLS_PRE']);

export function classifySmtpError(error: unknown): ClassifiedSmtpError {
  const e = error as { code?: string; responseCode?: number; command?: string; message?: string };
  if (typeof e.responseCode === 'number' && e.responseCode >= 400) {
    return {
      failureClass: 'REJECTED',
      detail: `SMTP ${e.responseCode} rejected at ${e.command ?? 'transaction'}`,
    };
  }
  if (e.code && NOT_SENT_CODES.has(e.code)) {
    return { failureClass: 'NOT_SENT', detail: `SMTP connection/auth failed (${e.code})` };
  }
  const code = e.code ?? 'UNKNOWN';
  return {
    failureClass: 'UNCERTAIN',
    detail: `SMTP outcome unknown (${code}); message may or may not have been accepted`,
  };
}
