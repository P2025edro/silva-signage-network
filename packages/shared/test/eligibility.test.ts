import { test } from 'node:test';
import assert from 'node:assert/strict';
import { campaignIneligibility, screenIneligibility } from '../src/index.js';
import { CAT, NOW, ZONE, campaign, policy, screen } from './fixtures.js';

const reasons = (c = campaign(), s = screen(), p = policy(), now = NOW) => campaignIneligibility(c, s, p, now);

test('approved, in-date campaign from another business is eligible', () => {
  assert.deepEqual(reasons(), []);
});

test('campaign states other than approved/scheduled/active never play', () => {
  for (const status of ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'CHANGES_REQUESTED', 'REJECTED', 'PAUSED', 'CANCELLED', 'COMPLETED'] as const) {
    assert.ok(reasons(campaign({ status })).includes('CAMPAIGN_NOT_APPROVED'), status);
  }
});

test('date window and schedule', () => {
  assert.ok(reasons(campaign({ startAt: new Date('2026-07-20T00:00:00Z') })).includes('BEFORE_START'));
  assert.ok(reasons(campaign({ endAt: NOW })).includes('AFTER_END'));
  // NOW is 12:00 Dublin; window 09:00-11:00 excludes it
  assert.ok(reasons(campaign({ schedule: { days: [3], startMinute: 540, endMinute: 660 } })).includes('OUTSIDE_SCHEDULE'));
});

test('advertiser subscription must be active and within allocation', () => {
  assert.ok(reasons(campaign({ advertiserSubscription: null })).includes('SUBSCRIPTION_INACTIVE'));
  const pastDue = campaign();
  pastDue.advertiserSubscription!.status = 'PAST_DUE';
  assert.ok(reasons(pastDue).includes('SUBSCRIPTION_INACTIVE'));
  const lapsed = campaign();
  lapsed.advertiserSubscription!.currentPeriodEnd = new Date('2026-07-01T00:00:00Z');
  assert.ok(reasons(lapsed).includes('SUBSCRIPTION_INACTIVE'));
  assert.ok(reasons(campaign({ advertiserPlaysThisPeriod: 3000 })).includes('QUOTA_EXHAUSTED'));
  assert.ok(reasons(campaign({ advertiserStatus: 'SUSPENDED' })).includes('ADVERTISER_SUSPENDED'));
});

test("advertiser's own screens are excluded by default, configurable", () => {
  const own = screen({ companyId: 'company-a' });
  assert.ok(reasons(campaign(), own).includes('OWN_SCREEN'));
  assert.deepEqual(reasons(campaign(), own, policy({ allowOwnScreens: true })), []);
});

test('geographic and venue targeting', () => {
  assert.ok(reasons(campaign({ targetZoneIds: [ZONE.cabra] })).includes('ZONE_MISMATCH'));
  assert.deepEqual(reasons(campaign({ targetZoneIds: [ZONE.cabra, ZONE.d8] })), []);
  assert.ok(reasons(campaign({ targetVenueCategoryIds: [CAT.grocery] })).includes('VENUE_CATEGORY_NOT_TARGETED'));
  assert.ok(reasons(campaign({ excludedVenueCategoryIds: [CAT.restaurant] })).includes('VENUE_CATEGORY_EXCLUDED'));
});

test('host competition rules: block beats allow, advertiser exclusion applies', () => {
  assert.ok(reasons(campaign(), screen({ blockedCategoryIds: [CAT.barber] })).includes('CATEGORY_BLOCKED_BY_HOST'));
  assert.ok(reasons(campaign(), screen({ allowedCategoryIds: [CAT.grocery] })).includes('CATEGORY_NOT_ALLOWED_BY_HOST'));
  assert.deepEqual(reasons(campaign(), screen({ allowedCategoryIds: [CAT.barber] })), []);
  const both = reasons(campaign(), screen({ allowedCategoryIds: [CAT.barber], blockedCategoryIds: [CAT.barber] }));
  assert.ok(both.includes('CATEGORY_BLOCKED_BY_HOST'));
  assert.ok(!both.includes('CATEGORY_NOT_ALLOWED_BY_HOST'));
  assert.ok(reasons(campaign(), screen({ excludedAdvertiserIds: ['company-a'] })).includes('ADVERTISER_EXCLUDED_BY_HOST'));
});

test('media compatibility: unsupported video, wrong codec and unready media are skipped', () => {
  const video = { id: 'v1', kind: 'VIDEO' as const, status: 'READY' as const, displaySeconds: 15, durationMs: 20_000, videoCodec: 'h264', position: 0 };
  assert.deepEqual(reasons(campaign({ media: [video] })), []);
  assert.ok(reasons(campaign({ media: [video] }), screen({ supportsVideo: false })).includes('NO_COMPATIBLE_MEDIA'));
  assert.ok(reasons(campaign({ media: [{ ...video, videoCodec: 'hevc' }] })).includes('NO_COMPATIBLE_MEDIA'));
  assert.ok(reasons(campaign({ media: [{ ...video, durationMs: 120_000 }] })).includes('NO_COMPATIBLE_MEDIA'));
  assert.ok(reasons(campaign({ media: [{ ...video, status: 'PROCESSING' }] })).includes('NO_COMPATIBLE_MEDIA'));
});

test('screen-level gates', () => {
  assert.deepEqual(screenIneligibility(screen(), policy(), NOW), []);
  assert.deepEqual(screenIneligibility(screen({ screenStatus: 'DISABLED' }), policy(), NOW), ['SCREEN_NOT_ACTIVE']);
  assert.deepEqual(screenIneligibility(screen({ participatesInNetwork: false }), policy(), NOW), ['LOCATION_NOT_PARTICIPATING']);
  assert.deepEqual(screenIneligibility(screen({ hostSubscriptionActive: false }), policy(), NOW), ['HOST_SUBSCRIPTION_INACTIVE']);
  assert.deepEqual(screenIneligibility(screen({ hostSubscriptionActive: false }), policy({ requireHostSubscription: false }), NOW), []);
  const closedNow = screen({ openingHours: { wed: [{ open: '14:00', close: '18:00' }] } });
  assert.deepEqual(screenIneligibility(closedNow, policy(), NOW), ['LOCATION_CLOSED']);
});
