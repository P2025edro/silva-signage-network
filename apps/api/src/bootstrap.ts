import Stripe from 'stripe';
import { loadConfig } from './config.js';
import { createSql } from './db.js';
import { createStorage } from './lib/storage.js';
import type { Deps } from './types.js';

export function createDeps(env: NodeJS.ProcessEnv = process.env): Deps {
  const config = loadConfig(env);
  return {
    config,
    sql: createSql(config.DATABASE_URL),
    storage: createStorage(config),
    stripe: config.STRIPE_SECRET_KEY ? new Stripe(config.STRIPE_SECRET_KEY) : null,
    now: () => new Date(),
  };
}
