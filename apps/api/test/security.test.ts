// Tenant isolation, role boundaries, authentication and CSRF.
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword } from '../src/lib/crypto.js';
import { totpAt } from '../src/lib/totp.js';
import { Client, devCompany, futureRange, login, pairScreen, PASSWORD, setup, silvaUser, testImage, type TestContext } from './helpers.js';

describe('tenant isolation', () => {
  let ctx: TestContext;
  let admin: Client;
  let A: Awaited<ReturnType<typeof devCompany>>;
  let B: Awaited<ReturnType<typeof devCompany>>;
  let campaignA: string;
  let mediaA: string;

  before(async () => {
    ctx = await setup();
    ({ client: admin } = await silvaUser(ctx));
    A = await devCompany(ctx, admin, { label: 'Iso A', category: 'barbershop', zones: ['dublin-8'] });
    B = await devCompany(ctx, admin, { label: 'Iso B', category: 'cafe', zones: ['dublin-8'] });
    mediaA = (await A.owner.upload(`/api/companies/${A.companyId}/media`, 'a.png', await testImage())).body.id;
    campaignA = (
      await A.owner.post(`/api/companies/${A.companyId}/campaigns`, { name: 'Private A', ...futureRange(ctx.clock), media: [{ mediaAssetId: mediaA }] })
    ).body.id;
  });
  after(() => ctx.close());

  test("Company B cannot read any of Company A's private data", async () => {
    for (const url of [
      `/api/companies/${A.companyId}`,
      `/api/companies/${A.companyId}/users`,
      `/api/companies/${A.companyId}/locations`,
      `/api/companies/${A.companyId}/screens`,
      `/api/companies/${A.companyId}/media`,
      `/api/companies/${A.companyId}/campaigns`,
      `/api/companies/${A.companyId}/campaigns/${campaignA}`,
      `/api/companies/${A.companyId}/campaigns/${campaignA}/report`,
      `/api/companies/${A.companyId}/billing`,
      `/api/companies/${A.companyId}/notifications`,
    ]) {
      const res = await B.owner.get(url);
      assert.equal(res.status, 404, `${url} returned ${res.status}`);
    }
  });

  test("Company B cannot modify Company A's data, even via its own company path", async () => {
    assert.equal((await B.owner.patch(`/api/companies/${A.companyId}`, { name: 'hijack', email: 'x@example.test' })).status, 404);
    assert.equal((await B.owner.post(`/api/companies/${A.companyId}/campaigns/${campaignA}/actions`, { action: 'SUBMIT' })).status, 404);
    // Campaign ID of A under B's company path → not found (company scoping in the query, not just the URL).
    assert.equal((await B.owner.get(`/api/companies/${B.companyId}/campaigns/${campaignA}`)).status, 404);
    // Attaching A's media to B's campaign is refused.
    const steal = await B.owner.post(`/api/companies/${B.companyId}/campaigns`, {
      name: 'Steal',
      ...futureRange(ctx.clock),
      media: [{ mediaAssetId: mediaA }],
    });
    assert.equal(steal.status, 400);
    // Pairing a TV into A's location from B's account fails.
    const tv = (await ctx.app.inject({ method: 'POST', url: '/api/device/pairing-sessions', payload: {} })).json();
    assert.equal(
      (await B.owner.post(`/api/companies/${B.companyId}/screens/pair`, { code: tv.code, locationId: A.locationId, displayName: 'Stolen TV' })).status,
      404,
    );
  });

  test('admin-only endpoints refuse business users', async () => {
    for (const url of ['/api/admin/companies', '/api/admin/screens', '/api/admin/overview', '/api/admin/audit-logs', '/api/admin/campaigns']) {
      assert.equal((await A.owner.get(url)).status, 403, url);
    }
  });

  test('staff can draft but not submit, pair screens, or manage users', async () => {
    const staffEmail = `staff-${randomUUID().slice(0, 6)}@example.test`;
    assert.equal(
      (await A.owner.post(`/api/companies/${A.companyId}/users`, { email: staffEmail, fullName: 'Staff', password: PASSWORD, role: 'STAFF' })).status,
      201,
    );
    const staff = await login(ctx, staffEmail);
    const draft = await staff.post(`/api/companies/${A.companyId}/campaigns`, {
      name: 'Staff draft',
      ...futureRange(ctx.clock),
      media: [{ mediaAssetId: mediaA }],
    });
    assert.equal(draft.status, 201);
    assert.equal((await staff.post(`/api/companies/${A.companyId}/campaigns/${draft.body.id}/actions`, { action: 'SUBMIT' })).status, 403);
    assert.equal(
      (await staff.post(`/api/companies/${A.companyId}/screens/pair`, { code: 'ABCD-EFGH', locationId: A.locationId, displayName: 'Staff TV' })).status,
      403,
    );
    assert.equal(
      (await staff.post(`/api/companies/${A.companyId}/users`, { email: 'z@example.test', fullName: 'Zed Person', password: PASSWORD, role: 'OWNER' })).status,
      403,
    );
  });

  test('network operators can review but not change company data or billing', async () => {
    const { client: op } = await silvaUser(ctx, 'NETWORK_OPERATOR');
    assert.equal((await op.get(`/api/companies/${A.companyId}`)).status, 200);
    assert.equal((await op.patch(`/api/companies/${A.companyId}`, { name: 'Renamed by operator', email: 'x@example.test' })).status, 403);
    assert.equal((await op.get('/api/admin/subscriptions')).status, 403);
    assert.equal((await op.post(`/api/admin/companies/${A.companyId}/subscriptions/manual`, { planCode: 'starter', periodDays: 1, note: 'nope' })).status, 403);
    assert.equal((await op.put('/api/admin/settings/distribution.slots_per_loop', { value: 6 })).status, 403);
    await A.owner.post(`/api/companies/${A.companyId}/campaigns/${campaignA}/actions`, { action: 'SUBMIT' });
    assert.equal((await op.post(`/api/companies/${A.companyId}/campaigns/${campaignA}/actions`, { action: 'APPROVE' })).status, 200);
  });

  test('a device token only reaches its own screen data', async () => {
    const s = await pairScreen(ctx, B.owner, B.companyId, B.locationId, 'B TV');
    // Device tokens are not user sessions.
    assert.equal((await s.device.get(`/api/companies/${B.companyId}`)).status, 401);
    // Commands for another screen cannot be acknowledged.
    const sA = await pairScreen(ctx, A.owner, A.companyId, A.locationId, 'A TV');
    const cmd = await admin.post(`/api/admin/screens/${sA.screenId}/commands`, { type: 'RELOAD_PLAYER' });
    assert.equal((await s.device.post(`/api/device/commands/${cmd.body.id}/ack`, { success: true })).status, 404);
    // Garbage tokens are refused.
    assert.equal((await new Client(ctx.app, 'x'.repeat(43)).get('/api/device/playlist')).status, 401);
  });
});

describe('authentication', () => {
  let ctx: TestContext;
  before(async () => {
    ctx = await setup();
  });
  after(() => ctx.close());

  async function user(role: 'NONE' | 'SUPER_ADMIN' = 'NONE') {
    const email = `u-${randomUUID().slice(0, 8)}@example.test`;
    await ctx.sql`INSERT INTO users (email, password_hash, full_name, platform_role) VALUES (${email}, ${await hashPassword(PASSWORD, 10)}, 'U', ${role})`;
    return email;
  }

  test('wrong passwords fail and lock the account after five attempts', async () => {
    const email = await user();
    const c = new Client(ctx.app);
    for (let i = 0; i < 5; i++) assert.equal((await c.post('/api/auth/login', { email, password: 'wrong-password-here' })).status, 401);
    const locked = await c.post('/api/auth/login', { email, password: PASSWORD });
    assert.equal(locked.status, 429);
    ctx.clock.advance(16 * 60_000);
    assert.equal((await c.post('/api/auth/login', { email, password: PASSWORD })).status, 200);
  });

  test('unknown emails get the same response as wrong passwords', async () => {
    const res = await new Client(ctx.app).post('/api/auth/login', { email: 'nobody@example.test', password: 'whatever-password' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.message, 'Incorrect email or password');
  });

  test('super admins must enrol in MFA before using admin endpoints, then verify every session', async () => {
    const email = await user('SUPER_ADMIN');
    const c = await login(ctx, email);
    const blocked = await c.get('/api/admin/overview');
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.error.code, 'MFA_ENROLLMENT_REQUIRED');

    const setupRes = await c.post('/api/auth/mfa/setup');
    assert.equal((await c.post('/api/auth/mfa/enable', { code: '000000' })).status, 400);
    assert.equal((await c.post('/api/auth/mfa/enable', { code: totpAt(setupRes.body.secret, ctx.clock.now().getTime()) })).status, 200);
    assert.equal((await c.get('/api/admin/overview')).status, 200);

    // New session: password alone is not enough.
    const c2 = await login(ctx, email);
    const needs = await c2.get('/api/admin/overview');
    assert.equal(needs.body.error.code, 'MFA_REQUIRED');
    assert.equal((await c2.post('/api/auth/mfa/verify', { code: '123456' })).status, 401);
    assert.equal((await c2.post('/api/auth/mfa/verify', { code: totpAt(setupRes.body.secret, ctx.clock.now().getTime()) })).status, 200);
    assert.equal((await c2.get('/api/admin/overview')).status, 200);
  });

  test('cookie-authenticated writes from other origins are rejected (CSRF)', async () => {
    const c = await login(ctx, await user());
    const res = await c.request('POST', '/api/auth/mfa/setup', {}, { origin: 'https://evil.example' });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'CSRF_REJECTED');
  });

  test('logout revokes the session server-side', async () => {
    const c = await login(ctx, await user());
    const cookie = c.cookie;
    await c.post('/api/auth/logout');
    c.cookie = cookie; // replay the old cookie
    assert.equal((await c.get('/api/auth/me')).status, 401);
  });

  test('passwords are stored as scrypt hashes', async () => {
    const [u] = await ctx.sql`SELECT password_hash FROM users LIMIT 1`;
    assert.match(u!.password_hash, /^scrypt\$\d+\$/);
  });
});
