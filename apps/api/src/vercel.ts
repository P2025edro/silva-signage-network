// Vercel Function entry point: the whole Fastify API behind one function.
// Built into .vercel/output by scripts/vercel-build.mjs; everything else (local dev, tests,
// container hosting) keeps using src/server.ts.
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { createDeps } from './bootstrap.js';

// Static ffmpeg/ffprobe builds are installed next to the bundle by scripts/vercel-build.mjs.
const here = dirname(fileURLToPath(import.meta.url));
for (const [env, rel] of [
  ['FFMPEG_PATH', 'node_modules/@ffmpeg-installer/linux-x64/ffmpeg'],
  ['FFPROBE_PATH', 'node_modules/@ffprobe-installer/linux-x64/ffprobe'],
] as const) {
  if (!process.env[env] && existsSync(join(here, rel))) process.env[env] = join(here, rel);
}

const ready = (async () => {
  const app = await buildApp(createDeps());
  await app.ready();
  return app;
})();

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const app = await ready;
  app.server.emit('request', req, res);
}
