import { startSink } from './smtp-sink.js';

// Developer tool: a local SMTP sink for an offline demo when Ethereal is unreachable.
// It is NOT the Ethereal integration. Real demo runs use `pnpm seed:ethereal`.
const port = Number(process.env.SINK_PORT ?? 2525);
const sink = await startSink({ port });
console.log(`SMTP sink listening on 127.0.0.1:${sink.port} (accepts any AUTH; stores nothing)`);
setInterval(() => console.log(`messages accepted so far: ${sink.received.length}`), 15_000);
