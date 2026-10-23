// Vercel Function entry point: the whole Fastify API behind one function.
// Built into .vercel/output by scripts/vercel-build.mjs; everything else (local dev, tests,
// container hosting) keeps using src/server.ts.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildApp } from './app.js';
import { createDeps } from './bootstrap.js';

const ready = (async () => {
  const app = await buildApp(createDeps());
  await app.ready();
  return app;
})();

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const app = await ready;
  app.server.emit('request', req, res);
}
