import { SMTPServer } from 'smtp-server';
import type { AddressInfo } from 'node:net';
import type { Socket } from 'node:net';

export interface ReceivedMessage {
  to: string;
  headers: string;
  emailHeader: string | null;
  bytes: number;
  at: number;
}

export interface SinkOptions {
  /** Recipients beginning with this prefix are rejected with 550 at RCPT TO. */
  rejectPrefix?: string;
  /** Recipients beginning with this prefix have their connection destroyed during DATA (ambiguous outcome). */
  dropPrefix?: string;
  /** Artificial latency before the DATA reply, to widen concurrency windows. */
  dataDelayMs?: number;
  /** Listening port (0 = random). */
  port?: number;
}

export interface Sink {
  port: number;
  received: ReceivedMessage[];
  /** Highest number of DATA transactions that were open at the same time. */
  maxConcurrentData: number;
  /** Count of connections that have issued MAIL FROM (SMTP attempts reaching the server). */
  transactions: number;
  close(): Promise<void>;
  reset(): void;
  options: SinkOptions;
}

/**
 * Controlled SMTP sink used in place of Ethereal for automated tests and offline demos.
 * It speaks real SMTP over TCP, so Nodemailer, timeouts and classification are exercised for real.
 */
export async function startSink(options: SinkOptions = {}): Promise<Sink> {
  const sockets = new Map<number, Socket>();
  const sink: Sink = {
    port: 0,
    received: [],
    maxConcurrentData: 0,
    transactions: 0,
    options,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    reset() {
      sink.received = [];
      sink.maxConcurrentData = 0;
      sink.transactions = 0;
    },
  };
  let openData = 0;

  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    logger: false,
    size: 10 * 1024 * 1024,
    onAuth(_auth, _session, cb) {
      cb(null, { user: 'sink' });
    },
    onMailFrom(_address, _session, cb) {
      sink.transactions += 1;
      cb();
    },
    onRcptTo(address, _session, cb) {
      if (options.rejectPrefix && address.address.startsWith(options.rejectPrefix)) {
        const err = new Error('mailbox unavailable') as Error & { responseCode?: number };
        err.responseCode = 550;
        cb(err);
        return;
      }
      cb();
    },
    onData(stream, session, cb) {
      const recipient = session.envelope.rcptTo[0]?.address ?? '';
      openData += 1;
      sink.maxConcurrentData = Math.max(sink.maxConcurrentData, openData);
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const headerEnd = raw.indexOf('\r\n\r\n');
        const headers = headerEnd >= 0 ? raw.slice(0, headerEnd) : raw;
        const match = /^X-ReachInbox-Email: (.+)$/im.exec(headers);
        const finish = () => {
          openData -= 1;
          if (options.dropPrefix && recipient.startsWith(options.dropPrefix)) {
            // Simulate the server accepting the message but the connection dying before the reply.
            sockets.get(session.remotePort)?.destroy();
            return;
          }
          sink.received.push({
            to: recipient,
            headers,
            emailHeader: match?.[1]?.trim() ?? null,
            bytes: raw.length,
            at: Date.now(),
          });
          cb(null, 'queued as sink-' + sink.received.length);
        };
        if (options.dataDelayMs) setTimeout(finish, options.dataDelayMs);
        else finish();
      });
    },
  });
  server.on('connection', (socket) => {
    // Track sockets by remote port so a specific connection can be dropped in fault tests.
    const port = (socket.remotePort ?? 0) as number;
    sockets.set(port, socket);
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', () => resolve()));
  sink.port = (server.server.address() as AddressInfo).port;
  return sink;
}
