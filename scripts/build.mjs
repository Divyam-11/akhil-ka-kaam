// Bundles the three Node processes (API, worker, dispatcher) into dist/ with esbuild.
// Workspace packages and npm dependencies are bundled; only optional native modules stay external.
import { build } from 'esbuild';

const root = new URL('../', import.meta.url);
// Native or optional modules that cannot be bundled and are resolved at runtime when present.
const external = ['pg-native', 'bufferutil', 'utf-8-validate', 'fsevents'];
// Everything else (npm packages included) is bundled, because pnpm's strict node_modules layout
// means an app directory cannot see the dependencies of the workspace packages it imports.

const entries = [
  ['apps/api/src/main.ts', 'apps/api/dist/main.js'],
  ['apps/worker/src/main.ts', 'apps/worker/dist/main.js'],
  ['apps/dispatcher/src/main.ts', 'apps/dispatcher/dist/main.js'],
];

for (const [entry, outfile] of entries) {
  await build({
    entryPoints: [new URL(entry, root).pathname],
    outfile: new URL(outfile, root).pathname,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'bundle',
    external,
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    sourcemap: 'linked',
    logLevel: 'warning',
  });
  console.log(`built ${outfile}`);
}
