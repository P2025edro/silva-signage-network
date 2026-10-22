// Integration-test harness. Runs the real app against a real PostgreSQL test database.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createSql, type Sql } from '../src/db.js';
import { encryptSecret, hashPassword } from '../src/lib/crypto.js';
import { LocalStorage } from '../src/lib/storage.js';
import { generateTotpSecret, totpAt } from '../src/lib/totp.js';
import { SETTING_DEFAULTS } from '../src/services/settings.js';
import type { Deps } from '../src/types.js';

export const ORIGIN = 'http://localhost:5173';
export const APP_SECRET = 'test-secret-test-secret-test-secret-0123456789';

export class Clock {
  constructor(public current = new Date()) {}
  now = () => new Date(this.current);
  advance(ms: number) {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export interface TestContext {
  app: FastifyInstance;
  deps: Deps;
  sql: Sql;
  clock: Clock;
  close(): Promise<void>;
}

export async function setup(envOverrides: Record<string, string> = {}): Promise<TestContext> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is required for integration tests');
  // Safety: these tests truncate tables, so never point them at a non-test database.
  if (!new URL(url).pathname.endsWith('_test')) throw new Error('TEST_DATABASE_URL must name a database ending in _test');

  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: url,
    APP_SECRET,
    API_PUBLIC_URL: 'http://localhost:4000',
    WEB_ORIGINS: ORIGIN,
    SCRYPT_LOG_N: '10',
    STORAGE_DRIVER: 'local',
    STORAGE_LOCAL_DIR: mkdtempSync(join(tmpdir(), 'silva-test-storage-')),
    ...envOverrides,
  });
  const sql = createSql(url);
  await resetDatabase(sql);
  const clock = new Clock();
  const deps: Deps = {
    config,
    sql,
    storage: new LocalStorage(config.STORAGE_LOCAL_DIR, config.API_PUBLIC_URL, config.APP_SECRET),
    stripe: null,
    now: clock.now,
  };
  const app = await buildApp(deps);
  return {
    app,
    deps,
    sql,
    clock,
    close: async () => {
      await app.close();
      await sql.end({ timeout: 5 });
    },
  };
}

export async function resetDatabase(sql: Sql) {
  await sql`TRUNCATE users, sessions, companies, user_company_memberships, locations, location_zones, location_category_rules,
    location_advertiser_exclusions, screens, device_pairing_sessions, device_credentials, screen_heartbeats, screen_commands,
    subscriptions, billing_events, media_assets, campaigns, campaign_reviews, campaign_media, campaign_targeting,
    campaign_target_categories, campaign_exclusions, screen_playlists, playlist_items, delivery_allocations, playback_events,
    audit_logs, notifications CASCADE`;
  for (const [key, value] of Object.entries(SETTING_DEFAULTS)) {
    await sql`UPDATE platform_settings SET value = ${sql.json(value)} WHERE key = ${key}`;
  }
}

/** Minimal HTTP client with a cookie jar, going through the full Fastify stack. */
export class Client {
  cookie = '';
  /** Each client gets its own address, as separate people would (keeps per-IP rate limits realistic). */
  readonly ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;
  constructor(
    private readonly app: FastifyInstance,
    private readonly bearer?: string,
  ) {}

  async request<T = any>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await this.app.inject({
      method: method as 'GET',
      url,
      remoteAddress: this.ip,
      payload: body === undefined ? undefined : (body as object),
      headers: {
        origin: ORIGIN,
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(this.bearer ? { authorization: `Bearer ${this.bearer}` } : {}),
        ...headers,
      },
    });
    const setCookie = res.headers['set-cookie'];
    const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    if (first) this.cookie = first.split(';')[0]!;
    let json: T | undefined;
    try {
      json = res.json() as T;
    } catch {
      json = undefined;
    }
    return { status: res.statusCode, body: json as T, raw: res };
  }
  get = <T = any>(url: string) => this.request<T>('GET', url);
  post = <T = any>(url: string, body: unknown = {}) => this.request<T>('POST', url, body);
  put = <T = any>(url: string, body: unknown) => this.request<T>('PUT', url, body);
  patch = <T = any>(url: string, body: unknown) => this.request<T>('PATCH', url, body);
  del = <T = any>(url: string) => this.request<T>('DELETE', url);

  async upload(url: string, filename: string, data: Buffer, contentType = 'application/octet-stream') {
    const boundary = `----silva${randomUUID()}`;
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await this.app.inject({
      method: 'POST',
      url,
      remoteAddress: this.ip,
      payload,
      headers: { origin: ORIGIN, cookie: this.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    return { status: res.statusCode, body: res.json() as any };
  }
}

export const PASSWORD = 'correct-horse-battery-staple';

/** Creates a Silva user directly (there is no public sign-up for Silva staff) and signs in, completing MFA. */
export async function silvaUser(ctx: TestContext, role: 'SUPER_ADMIN' | 'NETWORK_OPERATOR' = 'SUPER_ADMIN') {
  const email = `${role.toLowerCase()}-${randomUUID().slice(0, 8)}@silva.test`;
  const secret = generateTotpSecret();
  await ctx.sql`INSERT INTO users (email, password_hash, full_name, platform_role, totp_secret_enc, totp_enabled)
    VALUES (${email}, ${await hashPassword(PASSWORD, 10)}, ${'Test ' + role}, ${role}, ${encryptSecret(APP_SECRET, secret)}, true)`;
  const client = new Client(ctx.app);
  const login = await client.post('/api/auth/login', { email, password: PASSWORD });
  if (login.status !== 200 || !login.body.mfaRequired) throw new Error(`login failed ${JSON.stringify(login.body)}`);
  const mfa = await client.post('/api/auth/mfa/verify', { code: totpAt(secret, ctx.clock.now().getTime()) });
  if (mfa.status !== 200) throw new Error('mfa failed');
  return { client, email, secret };
}

export async function login(ctx: TestContext, email: string, password = PASSWORD) {
  const client = new Client(ctx.app);
  const res = await client.post('/api/auth/login', { email, password });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return client;
}

export async function zoneId(sql: Sql, slug: string): Promise<string> {
  const [z] = await sql<{ id: string }[]>`SELECT id FROM geographic_zones WHERE slug = ${slug}`;
  return z!.id;
}
export async function categoryId(sql: Sql, slug: string): Promise<string> {
  const [c] = await sql<{ id: string }[]>`SELECT id FROM business_categories WHERE slug = ${slug}`;
  return c!.id;
}

/** A clearly labelled fictional business with an owner, a location, and a manual (non-revenue) subscription. */
export async function devCompany(ctx: TestContext, admin: Client, opts: { label: string; category: string; zones: string[]; plan?: string }) {
  const slug = opts.label.toLowerCase().replace(/\W+/g, '-');
  const ownerEmail = `owner-${slug}-${randomUUID().slice(0, 6)}@example.test`;
  const created = await admin.post('/api/admin/companies', {
    name: `DEV FIXTURE — ${opts.label}`,
    email: `contact-${slug}@example.test`,
    categoryId: await categoryId(ctx.sql, opts.category),
    isDevFixture: true,
    owner: { email: ownerEmail, fullName: `${opts.label} Owner`, password: PASSWORD },
  });
  if (created.status !== 201) throw new Error(`company create failed ${JSON.stringify(created.body)}`);
  const companyId = created.body.id as string;
  const sub = await admin.post(`/api/admin/companies/${companyId}/subscriptions/manual`, {
    planCode: opts.plan ?? 'business',
    periodDays: 30,
    note: 'Development fixture entitlement — not a payment',
  });
  if (sub.status !== 201) throw new Error(`subscription failed ${JSON.stringify(sub.body)}`);
  const owner = await login(ctx, ownerEmail);
  const loc = await owner.post(`/api/companies/${companyId}/locations`, {
    name: `${opts.label} (dev location)`,
    streetAddress: '1 Example Street',
    eircode: 'D08 XY12',
    categoryId: await categoryId(ctx.sql, opts.category),
    zoneIds: await Promise.all(opts.zones.map((z) => zoneId(ctx.sql, z))),
  });
  if (loc.status !== 201) throw new Error(`location failed ${JSON.stringify(loc.body)}`);
  return { companyId, owner, ownerEmail, locationId: loc.body.id as string };
}

/** Runs the real TV pairing flow and returns a device client. */
export async function pairScreen(ctx: TestContext, owner: Client, companyId: string, locationId: string, displayName: string) {
  const tv = new Client(ctx.app);
  const session = await tv.request('POST', '/api/device/pairing-sessions', {}, { origin: 'http://localhost:5174' });
  if (session.status !== 201) throw new Error(`pairing session failed ${JSON.stringify(session.body)}`);
  const claim = await owner.post(`/api/companies/${companyId}/screens/pair`, { code: session.body.code, locationId, displayName });
  if (claim.status !== 201) throw new Error(`claim failed ${JSON.stringify(claim.body)}`);
  const poll = await tv.request('GET', `/api/device/pairing-sessions/${session.body.id}`, undefined, { 'x-poll-secret': session.body.pollSecret });
  if (poll.body.status !== 'PAIRED') throw new Error(`poll failed ${JSON.stringify(poll.body)}`);
  return { screenId: claim.body.id as string, device: new Client(ctx.app, poll.body.token), token: poll.body.token as string };
}

export async function testImage(width = 1280, height = 720, color = '#1f6feb'): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: color } })
    .png()
    .toBuffer();
}

export function futureRange(clock: Clock, startOffsetDays = -1, lengthDays = 14) {
  const start = new Date(clock.now().getTime() + startOffsetDays * 86_400_000);
  return { startAt: start.toISOString(), endAt: new Date(start.getTime() + lengthDays * 86_400_000).toISOString() };
}
