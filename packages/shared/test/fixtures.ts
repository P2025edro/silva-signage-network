// Test fixtures for the engine. All identifiers are clearly fictional.
import { DEFAULT_POLICY, type CampaignCandidate, type DistributionPolicy, type ScreenContext } from '../src/index.js';

export const NOW = new Date('2026-07-15T11:00:00Z'); // Wednesday 12:00 in Dublin (IST)

export const CAT = { barber: 'cat-barber', restaurant: 'cat-restaurant', grocery: 'cat-grocery' } as const;
export const ZONE = { d8: 'zone-d8', portobello: 'zone-portobello', cabra: 'zone-cabra' } as const;

export function screen(overrides: Partial<ScreenContext> = {}): ScreenContext {
  return {
    screenId: 'screen-b1',
    companyId: 'company-b',
    hostStatus: 'ACTIVE',
    hostSubscriptionActive: true,
    screenStatus: 'ACTIVE',
    locationId: 'location-b1',
    participatesInNetwork: true,
    venueCategoryId: CAT.restaurant,
    zoneIds: [ZONE.d8, ZONE.portobello],
    timezone: 'Europe/Dublin',
    openingHours: null,
    allowedCategoryIds: [],
    blockedCategoryIds: [],
    excludedAdvertiserIds: [],
    supportsVideo: true,
    ...overrides,
  };
}

let seq = 0;
export function campaign(overrides: Partial<CampaignCandidate> = {}): CampaignCandidate {
  seq++;
  const id = overrides.id ?? `campaign-${String(seq).padStart(3, '0')}`;
  return {
    id,
    name: `Test campaign ${id}`,
    companyId: 'company-a',
    advertiserStatus: 'ACTIVE',
    advertiserCategoryId: CAT.barber,
    advertiserSubscription: {
      status: 'ACTIVE',
      currentPeriodEnd: new Date('2026-08-01T00:00:00Z'),
      monthlyPlaybackAllocation: 3000,
      distributionWeight: 1,
    },
    advertiserPlaysThisPeriod: 0,
    status: 'ACTIVE',
    startAt: new Date('2026-07-01T00:00:00Z'),
    endAt: new Date('2026-07-31T00:00:00Z'),
    priority: 3,
    schedule: null,
    targetZoneIds: [],
    targetVenueCategoryIds: [],
    excludedVenueCategoryIds: [],
    media: [
      { id: `${id}-img1`, kind: 'IMAGE', status: 'READY', displaySeconds: 15, durationMs: null, videoCodec: null, position: 0 },
    ],
    ...overrides,
  };
}

export function policy(overrides: Partial<DistributionPolicy> = {}): DistributionPolicy {
  return { ...DEFAULT_POLICY, ...overrides };
}
