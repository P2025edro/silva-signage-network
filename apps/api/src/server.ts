import { buildApp } from './app.js';
import { createDeps } from './bootstrap.js';
import { startWorkers } from './workers/index.js';

const deps = createDeps();
const app = await buildApp(deps);
// Production runs workers as a separate process (src/worker.ts). For local development
// RUN_WORKERS_IN_PROCESS=true keeps everything in one terminal.
const stopWorkers = deps.config.RUN_WORKERS_IN_PROCESS ? startWorkers(deps, (m, e) => app.log.error({ err: e }, m)) : () => {};

await app.listen({ port: deps.config.API_PORT, host: deps.config.API_HOST });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    stopWorkers();
    await app.close();
    await deps.sql.end({ timeout: 5 });
    process.exit(0);
  });
}
