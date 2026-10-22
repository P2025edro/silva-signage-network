import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { devCompany, futureRange, pairScreen, setup, silvaUser, testImage, type TestContext, Client } from './helpers.js';

describe('subscription entitlements', () => {
  let ctx: TestContext;
  let admin: Client;
  let A: Awaited<ReturnType<typeof devCompany>>;
  let img: string;

  before(async () => {
    ctx = await setup();
    ({ client: admin } = await silvaUser(ctx));
    A = await devCompany(ctx, admin, { label: 'Starter Co', category: 'grocery', zones: ['cabra'], plan: 'starter' });
    img = (await A.owner.upload(`/api/companies/${A.companyId}/media`, 'x.png', await testImage())).body.id;
  });
  after(() => ctx.close());

  const newCampaign = (name: string, extra: Record<string, unknown> = {}) =>
    A.owner.post(`/api/companies/${A.companyId}/campaigns`, { name, ...futureRange(ctx.clock), media: [{ mediaAssetId: img }], ...extra });

  test('Starter allows one active campaign', async () => {
    const c1 = await newCampaign('One');
    assert.equal((await A.owner.post(`/api/companies/${A.companyId}/campaigns/${c1.body.id}/actions`, { action: 'SUBMIT' })).status, 200);
    const c2 = await newCampaign('Two');
    const res = await A.owner.post(`/api/companies/${A.companyId}/campaigns/${c2.body.id}/actions`, { action: 'SUBMIT' });
    assert.equal(res.status, 402);
    assert.equal(res.body.error.code, 'ENTITLEMENT_EXCEEDED');
    await A.owner.post(`/api/companies/${A.companyId}/campaigns/${c1.body.id}/actions`, { action: 'CANCEL' });
  });

  test('campaign length and zone count are limited by plan', async () => {
    const long = await newCampaign('Long', futureRange(ctx.clock, 0, 60));
    assert.equal((await A.owner.post(`/api/companies/${A.companyId}/campaigns/${long.body.id}/actions`, { action: 'SUBMIT' })).status, 402);
    const zones = (await ctx.sql`SELECT id FROM geographic_zones LIMIT 3`).map((z) => z.id);
    const wide = await newCampaign('Wide', { targetZoneIds: zones });
    assert.equal((await A.owner.post(`/api/companies/${A.companyId}/campaigns/${wide.body.id}/actions`, { action: 'SUBMIT' })).status, 402);
  });

  test('Starter allows one screen', async () => {
    await pairScreen(ctx, A.owner, A.companyId, A.locationId, 'First');
    const tv = (await ctx.app.inject({ method: 'POST', url: '/api/device/pairing-sessions', payload: {} })).json();
    const res = await A.owner.post(`/api/companies/${A.companyId}/screens/pair`, { code: tv.code, locationId: A.locationId, displayName: 'Second' });
    assert.equal(res.status, 402);
  });

  test('without an active subscription nothing can be submitted and nothing is distributed', async () => {
    const subs = await admin.get('/api/admin/subscriptions');
    const sub = subs.body.find((s: { companyId: string; status: string }) => s.companyId === A.companyId && s.status === 'ACTIVE');
    await admin.post(`/api/admin/subscriptions/${sub.id}/cancel`);
    const c = await newCampaign('After cancel');
    const res = await A.owner.post(`/api/companies/${A.companyId}/campaigns/${c.body.id}/actions`, { action: 'SUBMIT' });
    assert.equal(res.status, 402);
  });

  test('manual subscriptions never count as revenue', async () => {
    const o = await admin.get('/api/admin/overview');
    assert.equal(o.body.verifiedMrrCents, 0);
    assert.equal(o.body.paidSubscriptions, 0);
  });
});

describe('media validation', () => {
  let ctx: TestContext;
  let A: Awaited<ReturnType<typeof devCompany>>;
  before(async () => {
    ctx = await setup();
    const { client: admin } = await silvaUser(ctx);
    A = await devCompany(ctx, admin, { label: 'Media Co', category: 'retail', zones: ['rathmines'] });
  });
  after(() => ctx.close());

  const upload = (name: string, data: Buffer, type?: string) => A.owner.upload(`/api/companies/${A.companyId}/media`, name, data, type);

  test('file type comes from content, not the extension or declared MIME type', async () => {
    const res = await upload('advert.png', Buffer.from('<script>alert(1)</script>'), 'image/png');
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'MEDIA_REJECTED');
    const svgish = await upload('advert.jpg', Buffer.from('<?xml version="1.0"?><svg></svg>'), 'image/jpeg');
    assert.equal(svgish.status, 422);
  });

  test('images that are too small are rejected; valid images are re-encoded for TV delivery', async () => {
    assert.equal((await upload('tiny.png', await testImage(200, 100))).status, 422);
    const ok = await upload('big.png', await testImage(3840, 2160));
    assert.equal(ok.status, 201);
    assert.equal(ok.body.width, 1920);
    assert.equal(ok.body.height, 1080);
    assert.ok(ok.body.thumbnailUrl);
  });

  test('videos are probed, and non-H.264 video is transcoded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vid-'));
    const path = join(dir, 'in.mp4');
    // MPEG-4 Part 2 video in an MP4 container: valid MP4, but not the delivery codec.
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25', '-t', '3', '-c:v', 'mpeg4', path]);
    const res = await upload('clip.mp4', readFileSync(path), 'video/mp4');
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.kind, 'VIDEO');
    assert.equal(res.body.videoCodec, 'h264');
    assert.ok(res.body.durationMs >= 2900 && res.body.durationMs <= 3200);
  });

  test('videos over the length limit are rejected', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vid-'));
    const path = join(dir, 'long.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=5', '-t', '61', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path]);
    const res = await upload('long.mp4', readFileSync(path));
    assert.equal(res.status, 422);
  });
});

describe('Stripe webhooks', () => {
  let ctx: TestContext;
  let admin: Client;
  let companyId: string;
  const secret = 'whsec_test_secret';
  const stripe = new Stripe('sk_test_dummy_key_for_signature_generation_only');

  before(async () => {
    ctx = await setup({ STRIPE_SECRET_KEY: 'sk_test_dummy', STRIPE_WEBHOOK_SECRET: secret });
    ctx.deps.stripe = stripe;
    ({ client: admin } = await silvaUser(ctx));
    companyId = (await admin.post('/api/admin/companies', { name: 'DEV FIXTURE — Billing Co', email: 'billing@example.test', isDevFixture: true })).body.id;
    await ctx.sql`UPDATE subscription_plans SET stripe_price_id = 'price_test_business' WHERE code = 'business'`;
  });
  after(() => ctx.close());

  function deliver(event: object, sig?: string) {
    const payload = JSON.stringify(event);
    const header = sig ?? stripe.webhooks.generateTestHeaderString({ payload, secret });
    return ctx.app.inject({
      method: 'POST',
      url: '/api/billing/stripe/webhook',
      payload,
      headers: { 'content-type': 'application/json', 'stripe-signature': header },
    });
  }

  const subEvent = (id: string) => ({
    id,
    object: 'event',
    type: 'customer.subscription.created',
    data: {
      object: {
        id: 'sub_test_1',
        object: 'subscription',
        customer: 'cus_test_1',
        status: 'active',
        cancel_at_period_end: false,
        start_date: Math.floor(ctx.clock.now().getTime() / 1000),
        metadata: { company_id: companyId },
        items: {
          data: [
            {
              price: { id: 'price_test_business' },
              current_period_start: Math.floor(ctx.clock.now().getTime() / 1000),
              current_period_end: Math.floor(ctx.clock.now().getTime() / 1000) + 30 * 86400,
            },
          ],
        },
      },
    },
  });

  test('unsigned or tampered events are rejected', async () => {
    const res = await deliver(subEvent('evt_bad'), 't=1,v1=deadbeef');
    assert.equal(res.statusCode, 400);
    assert.equal((await ctx.sql`SELECT count(*)::int AS n FROM billing_events`)[0]!.n, 0);
  });

  test('a verified subscription event activates the subscription, once', async () => {
    assert.equal((await deliver(subEvent('evt_1'))).statusCode, 200);
    const dup = await deliver(subEvent('evt_1'));
    assert.equal(dup.json().duplicate, true);
    const subs = await ctx.sql`SELECT status, source FROM subscriptions WHERE company_id = ${companyId}`;
    assert.equal(subs.length, 1);
    assert.equal(subs[0]!.source, 'STRIPE');
    assert.equal(subs[0]!.status, 'ACTIVE');
    const o = await admin.get('/api/admin/overview');
    assert.equal(o.body.verifiedMrrCents, 5900);
  });

  test('a failed payment notifies the business', async () => {
    const res = await deliver({
      id: 'evt_2',
      object: 'event',
      type: 'invoice.payment_failed',
      data: { object: { id: 'in_1', object: 'invoice', customer: 'cus_test_1', amount_due: 5900, currency: 'eur' } },
    });
    assert.equal(res.statusCode, 200);
    const [n] = await ctx.sql`SELECT count(*)::int AS n FROM notifications WHERE company_id = ${companyId} AND type = 'billing.payment_failed'`;
    assert.equal(n!.n, 1);
  });

  test('checkout reports clearly when billing is not configured', async () => {
    ctx.deps.stripe = null;
    const res = await admin.post(`/api/companies/${companyId}/billing/checkout`, { planCode: 'business' });
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'BILLING_NOT_CONFIGURED');
  });
});
