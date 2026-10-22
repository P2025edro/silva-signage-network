import type Stripe from 'stripe';
import type { Config } from './config.js';
import type { Sql } from './db.js';
import type { Storage } from './lib/storage.js';

export interface Deps {
  config: Config;
  sql: Sql;
  storage: Storage;
  stripe: Stripe | null;
  /** Injectable clock so tests can control time. */
  now: () => Date;
}

export type PlatformRole = 'SUPER_ADMIN' | 'NETWORK_OPERATOR' | 'NONE';
export type CompanyRole = 'OWNER' | 'STAFF';

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  platformRole: PlatformRole;
  totpEnabled: boolean;
}

export interface AuthContext {
  user: AuthUser;
  sessionId: string;
  mfaVerified: boolean;
  memberships: Array<{ companyId: string; role: CompanyRole; companyName: string }>;
}

export interface DeviceContext {
  screenId: string;
  companyId: string;
  locationId: string;
  credentialId: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: Deps;
  }
  interface FastifyRequest {
    auth: AuthContext | null;
    device: DeviceContext | null;
  }
}
