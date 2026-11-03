import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface WebhookHit {
  body: { text?: string };
  at: number;
}

export interface WebhookServer {
  url: string;
  hits: WebhookHit[];
  /** Queue of responses to return for upcoming requests (default is 200). */
  next: Array<{ status: number; retryAfter?: string }>;
  close(): Promise<void>;
}

/** Local stand-in for a Slack incoming webhook. Records each posted message. */
export async function startWebhookServer(): Promise<WebhookServer> {
  const server: WebhookServer = {
    url: '',
    hits: [],
    next: [],
    close: async () => undefined,
  };
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const planned = server.next.shift() ?? { status: 200 };
      if (planned.status === 200) {
        server.hits.push({ body: JSON.parse(raw || '{}') as { text?: string }, at: Date.now() });
      }
      res.statusCode = planned.status;
      if (planned.retryAfter) res.setHeader('Retry-After', planned.retryAfter);
      res.end(planned.status === 200 ? 'ok' : 'error');
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  server.url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/services/T/B/X`;
  server.close = () => new Promise<void>((resolve) => srv.close(() => resolve()));
  return server;
}
