import { createDeps } from './bootstrap.js';
import { startWorkers } from './workers/index.js';

const deps = createDeps();
const stop = startWorkers(deps, (msg, err) => console.error(`[worker] ${msg}`, err));
console.log('[worker] campaign scheduler and maintenance running');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    stop();
    await deps.sql.end({ timeout: 5 });
    process.exit(0);
  });
}
