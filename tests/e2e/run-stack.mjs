// Starts the backend trio used by the e2e suite as one Playwright webServer entry: API, email
// worker and outbox dispatcher. A single entry keeps Playwright's readiness check on the API and
// guarantees all three start (separate entries that share a readiness URL are reused, not started).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const entries = ['apps/api/src/main.ts', 'apps/worker/src/main.ts', 'apps/dispatcher/src/main.ts'];
const children = entries.map((entry) =>
  spawn('pnpm', ['exec', 'tsx', entry], { cwd: root, stdio: 'inherit', env: process.env }),
);

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 1500).unref();
}
for (const c of children) c.on('exit', (code) => stop(code ?? 0));
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
