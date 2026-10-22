import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScreenPlaylist, deliveryShortfall, estimateDailyPlays } from '../src/index.js';
import { CAT, NOW, campaign, policy, screen } from './fixtures.js';

test('cross-business: Company A campaign reaches Company B screen, not its own', () => {
  const ad = campaign({ id: 'camp-a', companyId: 'company-a' });
  const onB = buildScreenPlaylist(screen({ screenId: 'screen-b', companyId: 'company-b' }), [ad], policy(), NOW);
  assert.equal(onB.items.length, 1);
  assert.equal(onB.items[0]!.campaignId, 'camp-a');
  assert.equal(onB.items[0]!.advertiserCompanyId, 'company-a');

  const onA = buildScreenPlaylist(screen({ screenId: 'screen-a', companyId: 'company-a' }), [ad], policy(), NOW);
  assert.equal(onA.items.length, 0);
  assert.deepEqual(onA.decisions[0]!.reasons, ['OWN_SCREEN']);
});

test('three-business network: each screen carries the other two businesses', () => {
  const barber = campaign({ id: 'c-barber', companyId: 'company-a', advertiserCategoryId: CAT.barber });
  const food = campaign({ id: 'c-food', companyId: 'company-b', advertiserCategoryId: CAT.restaurant });
  const shop = campaign({ id: 'c-shop', companyId: 'company-c', advertiserCategoryId: CAT.grocery });
  const all = [barber, food, shop];
  const ids = (companyId: string) =>
    buildScreenPlaylist(screen({ screenId: `s-${companyId}`, companyId }), all, policy(), NOW)
      .items.map((i) => i.campaignId)
      .sort();
  assert.deepEqual(ids('company-a'), ['c-food', 'c-shop']);
  assert.deepEqual(ids('company-b'), ['c-barber', 'c-shop']);
  assert.deepEqual(ids('company-c'), ['c-barber', 'c-food']);
});

test('a barbershop can refuse competing barbershop adverts', () => {
  const rival = campaign({ id: 'rival', companyId: 'company-x', advertiserCategoryId: CAT.barber });
  const p = buildScreenPlaylist(screen({ venueCategoryId: CAT.barber, blockedCategoryIds: [CAT.barber] }), [rival], policy(), NOW);
  assert.equal(p.items.length, 0);
  assert.deepEqual(p.decisions[0]!.reasons, ['CATEGORY_BLOCKED_BY_HOST']);
});

test('paused and expired campaigns are not included in newly generated playlists', () => {
  const live = campaign({ id: 'live' });
  const paused = campaign({ id: 'paused', status: 'PAUSED', companyId: 'company-c' });
  const expired = campaign({ id: 'expired', endAt: new Date('2026-07-10T00:00:00Z'), companyId: 'company-d' });
  const p = buildScreenPlaylist(screen(), [live, paused, expired], policy(), NOW);
  assert.deepEqual(
    p.items.map((i) => i.campaignId),
    ['live'],
  );
});

test('playlist expires at the next quarter hour or campaign end, whichever is first', () => {
  const endingSoon = campaign({ id: 'soon', endAt: new Date('2026-07-15T11:05:00Z') });
  assert.equal(buildScreenPlaylist(screen(), [endingSoon], policy(), NOW).validUntil.toISOString(), '2026-07-15T11:05:00.000Z');
  assert.equal(buildScreenPlaylist(screen(), [campaign()], policy(), NOW).validUntil.toISOString(), '2026-07-15T11:15:00.000Z');
  const startingSoon = campaign({ id: 'later', startAt: new Date('2026-07-15T11:07:00Z') });
  assert.equal(buildScreenPlaylist(screen(), [startingSoon], policy(), NOW).validUntil.toISOString(), '2026-07-15T11:07:00.000Z');
});

test('items carry notAfter so cached content cannot outlive the campaign', () => {
  const c = campaign();
  const p = buildScreenPlaylist(screen(), [c], policy(), NOW);
  assert.equal(p.items[0]!.notAfter.toISOString(), c.endAt.toISOString());
});

test('ineligible screen receives a fallback-only playlist with reasons', () => {
  const p = buildScreenPlaylist(screen({ screenStatus: 'DISABLED' }), [campaign()], policy(), NOW);
  assert.equal(p.items.length, 0);
  assert.deepEqual(p.screenReasons, ['SCREEN_NOT_ACTIVE']);
  assert.match(p.fingerprint, /^fallback/);
});

test('same inputs produce the same fingerprint; content change alters it', () => {
  const cs = [campaign({ id: 'p1' }), campaign({ id: 'p2', companyId: 'company-c' })];
  const a = buildScreenPlaylist(screen(), cs, policy(), NOW);
  const b = buildScreenPlaylist(screen(), cs, policy(), new Date(NOW.getTime() + 60_000));
  assert.equal(a.fingerprint, b.fingerprint);
  const c = buildScreenPlaylist(screen(), cs.slice(0, 1), policy(), NOW);
  assert.notEqual(a.fingerprint, c.fingerprint);
});

test('video duration comes from the media; images use display seconds', () => {
  const c = campaign({
    media: [{ id: 'v', kind: 'VIDEO', status: 'READY', displaySeconds: 15, durationMs: 20_400, videoCodec: 'h264', position: 0 }],
  });
  assert.equal(buildScreenPlaylist(screen(), [c], policy(), NOW).items[0]!.durationSec, 21);
});

test('creatives rotate across quarter hours when slots are fewer than creatives', () => {
  const media = ['m1', 'm2', 'm3'].map((id, position) => ({
    id,
    kind: 'IMAGE' as const,
    status: 'READY' as const,
    displaySeconds: 10,
    durationMs: null,
    videoCodec: null,
    position,
  }));
  // Two advertisers so the creative-carrying campaign is capped below 3 slots
  const many = campaign({ id: 'many', media, priority: 1 });
  const other = campaign({ id: 'other', companyId: 'company-c', priority: 5 });
  const tiny = policy({ slotsPerLoop: 2 });
  const first = buildScreenPlaylist(screen(), [many, other], tiny, NOW).items.find((i) => i.campaignId === 'many')!;
  const later = buildScreenPlaylist(screen(), [many, other], tiny, new Date(NOW.getTime() + 15 * 60_000)).items.find((i) => i.campaignId === 'many')!;
  assert.notEqual(first.mediaAssetId, later.mediaAssetId);
});

test('capacity estimate and shortfall', () => {
  const perDay = estimateDailyPlays({ slotsInLoop: 1, loopSeconds: 60, openingHours: { wed: [{ open: '09:00', close: '17:00' }] }, isoWeekday: 3 });
  assert.equal(perDay, 480); // 8h × 60 loops/h
  assert.equal(deliveryShortfall(600, perDay), 120);
  assert.equal(deliveryShortfall(null, perDay), 0);
  assert.equal(estimateDailyPlays({ slotsInLoop: 1, loopSeconds: 60, openingHours: { mon: [] }, isoWeekday: 3 }), 0);
});
