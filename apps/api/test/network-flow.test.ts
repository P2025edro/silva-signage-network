// The defining scenario: a business uploads an advert, Silva approves it, and it is delivered
// to a paired screen belonging to a different participating business. Everything goes through
// the real HTTP API and database.
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { schedulerTick } from '../src/workers/index.js';
import { devCompany, futureRange, login, pairScreen, setup, silvaUser, testImage, type TestContext } from './helpers.js';

describe('cross-business advertising', () => {
  let ctx: TestContext;
  let admin: Awaited<ReturnType<typeof silvaUser>>['client'];
  let A: Awaited<ReturnType<typeof devCompany>>;
  let B: Awaited<ReturnType<typeof devCompany>>;
  let screenA: Awaited<ReturnType<typeof pairScreen>>;
  let screenB: Awaited<ReturnType<typeof pairScreen>>;
  let campaignId: string;
  let mediaId: string;

  before(async () => {
    ctx = await setup();
    ({ client: admin } = await silvaUser(ctx));
    A = await devCompany(ctx, admin, { label: 'Company A Barbershop', category: 'barbershop', zones: ['camden-street', 'dublin-8'] });
    B = await devCompany(ctx, admin, { label: 'Company B Restaurant', category: 'restaurant', zones: ['portobello', 'dublin-8'] });
  });
  after(() => ctx.close());

  test('each business pairs its own TV through the pairing-code flow', async () => {
    screenA = await pairScreen(ctx, A.owner, A.companyId, A.locationId, 'Screen A — waiting area');
    screenB = await pairScreen(ctx, B.owner, B.companyId, B.locationId, 'Screen B — dining room');
    const cfg = await screenB.device.get('/api/device/config');
    assert.equal(cfg.status, 200);
    assert.equal(cfg.body.screenId, screenB.screenId);
    assert.equal(cfg.body.displayName, 'Screen B — dining room');
  });

  test('pairing codes are single-use', async () => {
    const tv = await ctx.app.inject({ method: 'POST', url: '/api/device/pairing-sessions', payload: {} });
    const { code } = tv.json();
    const first = await B.owner.post(`/api/companies/${B.companyId}/screens/pair`, { code, locationId: B.locationId, displayName: 'Extra' });
    assert.equal(first.status, 201);
    const second = await B.owner.post(`/api/companies/${B.companyId}/screens/pair`, { code, locationId: B.locationId, displayName: 'Extra 2' });
    assert.equal(second.status, 400);
    await B.owner.post(`/api/companies/${B.companyId}/screens/${first.body.id}/unpair`);
  });

  test('Company A uploads an advert and creates a campaign', async () => {
    const up = await A.owner.upload(`/api/companies/${A.companyId}/media`, 'camden-fade.png', await testImage(1920, 1080));
    assert.equal(up.status, 201, JSON.stringify(up.body));
    assert.equal(up.body.kind, 'IMAGE');
    assert.equal(up.body.status, 'READY');
    mediaId = up.body.id;

    const created = await A.owner.post(`/api/companies/${A.companyId}/campaigns`, {
      name: 'Autumn fades — 10% off',
      ...futureRange(ctx.clock),
      media: [{ mediaAssetId: mediaId, displaySeconds: 10 }],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    campaignId = created.body.id;
  });

  test('a draft campaign is not distributed', async () => {
    const pl = await screenB.device.get('/api/device/playlist');
    assert.equal(pl.status, 200);
    assert.equal(pl.body.items.length, 0);
  });

  test('the business cannot approve its own campaign', async () => {
    await A.owner.post(`/api/companies/${A.companyId}/campaigns/${campaignId}/actions`, { action: 'SUBMIT' });
    const res = await A.owner.post(`/api/companies/${A.companyId}/campaigns/${campaignId}/actions`, { action: 'APPROVE' });
    assert.equal(res.status, 403);
  });

  test('Silva reviews and approves', async () => {
    const queue = await admin.get('/api/admin/campaigns?status=SUBMITTED,UNDER_REVIEW');
    assert.ok(queue.body.items.some((c: { id: string }) => c.id === campaignId));
    assert.equal((await admin.post(`/api/companies/${A.companyId}/campaigns/${campaignId}/actions`, { action: 'START_REVIEW' })).body.status, 'UNDER_REVIEW');
    const approved = await admin.post(`/api/companies/${A.companyId}/campaigns/${campaignId}/actions`, { action: 'APPROVE' });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.status, 'ACTIVE');
    const notes = await A.owner.get(`/api/companies/${A.companyId}/notifications`);
    assert.ok(notes.body.some((n: { type: string }) => n.type === 'campaign.approve'));
  });

  test("the approved advert reaches Company B's screen — and not Company A's own", async () => {
    const onB = await screenB.device.get('/api/device/playlist');
    assert.equal(onB.body.items.length, 1);
    assert.equal(onB.body.items[0].campaignId, campaignId);
    assert.equal(onB.body.items[0].mediaAssetId, mediaId);
    assert.equal(onB.body.items[0].kind, 'IMAGE');

    const onA = await screenA.device.get('/api/device/playlist');
    assert.equal(onA.body.items.length, 0);

    // Engine reasoning is visible to Silva.
    const explain = await admin.get(`/api/admin/network/screens/${screenA.screenId}/playlist`);
    const d = explain.body.decisions.find((x: { campaignId: string }) => x.campaignId === campaignId);
    assert.deepEqual(d.reasons, ['OWN_SCREEN']);
  });

  test('the signed media URL serves the advert to the player; tampered URLs are refused', async () => {
    const pl = await screenB.device.get('/api/device/playlist');
    const url = new URL(pl.body.items[0].url);
    const ok = await ctx.app.inject({ method: 'GET', url: url.pathname + url.search });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.headers['content-type'], 'image/jpeg');
    const bad = await ctx.app.inject({ method: 'GET', url: url.pathname + url.search.replace(/sig=./, 'sig=X') });
    assert.equal(bad.statusCode, 403);
  });

  test('unchanged playlists are not re-sent', async () => {
    const pl = await screenB.device.get('/api/device/playlist');
    const again = await screenB.device.get(`/api/device/playlist?knownVersion=${pl.body.version}`);
    assert.equal(again.body.unchanged, true);
  });

  test('playback events are recorded once, and forged events are rejected', async () => {
    const pl = await screenB.device.get('/api/device/playlist');
    const now = ctx.clock.now().toISOString();
    const base = { campaignId, mediaAssetId: mediaId, playlistVersion: pl.body.version, occurredAt: now };
    const started = { ...base, id: randomUUID(), type: 'STARTED' };
    const completed = { ...base, id: randomUUID(), type: 'COMPLETED' };
    const first = await screenB.device.post('/api/device/playback-events', { events: [started, completed] });
    assert.deepEqual(first.body, { accepted: 2, duplicates: 0, rejected: 0 });
    const retry = await screenB.device.post('/api/device/playback-events', { events: [started] });
    assert.deepEqual(retry.body, { accepted: 0, duplicates: 1, rejected: 0 });

    // Screen A never had this campaign in its playlist, so it cannot claim plays for it.
    const plA = await screenA.device.get('/api/device/playlist');
    const forged = await screenA.device.post('/api/device/playback-events', {
      events: [{ ...base, id: randomUUID(), type: 'STARTED', playlistVersion: plA.body.version }],
    });
    assert.equal(forged.body.rejected, 1);

    const report = await A.owner.get(`/api/companies/${A.companyId}/campaigns/${campaignId}/report`);
    assert.equal(report.body.totals.started, 1);
    assert.equal(report.body.totals.completed, 1);
    assert.equal(report.body.byLocation[0].screen, 'Screen B — dining room');
    assert.equal(report.body.quota.usedThisPeriod, 1);
  });

  test('heartbeats update monitoring and deliver commands', async () => {
    const cmd = await admin.post(`/api/admin/screens/${screenB.screenId}/commands`, { type: 'REFRESH_PLAYLIST', idempotencyKey: 'k1' });
    const dup = await admin.post(`/api/admin/screens/${screenB.screenId}/commands`, { type: 'REFRESH_PLAYLIST', idempotencyKey: 'k1' });
    assert.equal(dup.body.id, cmd.body.id);
    assert.equal(dup.body.duplicate, true);

    const pl = await screenB.device.get('/api/device/playlist');
    const hb = await screenB.device.post('/api/device/heartbeat', {
      playbackState: 'PLAYING',
      playlistVersion: pl.body.version,
      playerVersion: '0.1.0',
      platform: 'Test',
      screenWidth: 1920,
      screenHeight: 1080,
      supportsVideo: true,
    });
    assert.equal(hb.status, 200);
    assert.equal(hb.body.commands.length, 1);
    assert.equal((await screenB.device.post(`/api/device/commands/${cmd.body.id}/ack`, { success: true })).status, 200);

    const screens = await admin.get('/api/admin/screens');
    const b = screens.body.find((s: { id: string }) => s.id === screenB.screenId);
    assert.equal(b.health, 'PLAYING');
    const a = screens.body.find((s: { id: string }) => s.id === screenA.screenId);
    assert.equal(a.health, 'NEVER_CONNECTED');
  });

  test('pausing removes the campaign from newly generated playlists; resuming restores it', async () => {
    await A.owner.post(`/api/companies/${A.companyId}/campaigns/${campaignId}/actions`, { action: 'PAUSE' });
    assert.equal((await screenB.device.get('/api/device/playlist')).body.items.length, 0);
    await A.owner.post(`/api/companies/${A.companyId}/campaigns/${campaignId}/actions`, { action: 'RESUME' });
    assert.equal((await screenB.device.get('/api/device/playlist')).body.items.length, 1);
  });

  test('a barbershop host can block barbershop adverts', async () => {
    // Company B (restaurant) blocks barbershops; A's ad disappears from B's screen.
    const barber = (await ctx.sql`SELECT id FROM business_categories WHERE slug = 'barbershop'`)[0]!.id;
    const res = await B.owner.put(`/api/companies/${B.companyId}/locations/${B.locationId}/rules`, { blockCategoryIds: [barber] });
    assert.equal(res.status, 200);
    assert.equal((await screenB.device.get('/api/device/playlist')).body.items.length, 0);
    await B.owner.put(`/api/companies/${B.companyId}/locations/${B.locationId}/rules`, {});
    assert.equal((await screenB.device.get('/api/device/playlist')).body.items.length, 1);
  });

  test('when a campaign ends, the scheduler completes it and it leaves playlists', async () => {
    ctx.clock.advance(15 * 86_400_000);
    const tick = await schedulerTick(ctx.deps);
    assert.ok(tick.transitions >= 1);
    // Sessions idle-expire over 15 days; sign in again.
    assert.equal((await A.owner.get(`/api/companies/${A.companyId}`)).status, 401);
    A.owner = await login(ctx, A.ownerEmail);
    B.owner = await login(ctx, B.ownerEmail);
    const detail = await A.owner.get(`/api/companies/${A.companyId}/campaigns/${campaignId}`);
    assert.equal(detail.body.status, 'COMPLETED');
    assert.equal((await screenB.device.get('/api/device/playlist')).body.items.length, 0);
  });

  test('unpairing revokes the device credential', async () => {
    await B.owner.post(`/api/companies/${B.companyId}/screens/${screenB.screenId}/unpair`);
    const res = await screenB.device.get('/api/device/playlist');
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'DEVICE_NOT_PAIRED');
  });

  test('every critical step left an audit trail', async () => {
    const actions = (await ctx.sql`SELECT DISTINCT action FROM audit_logs`).map((r) => r.action);
    for (const a of [
      'company.created',
      'screen.paired',
      'media.uploaded',
      'campaign.submit',
      'campaign.approve',
      'campaign.pause',
      'screen.unpaired',
      'campaign.status_advanced',
    ]) {
      assert.ok(actions.includes(a), `missing audit action ${a}`);
    }
  });
});
