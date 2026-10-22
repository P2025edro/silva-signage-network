export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Ref {
  id: string;
  name: string;
  slug: string;
}

export interface Location {
  id: string;
  companyId: string;
  companyName: string;
  name: string;
  streetAddress: string;
  eircode: string | null;
  city: string;
  neighbourhood: string | null;
  latitude: number | null;
  longitude: number | null;
  coordinatesVerified: boolean;
  categoryId: string | null;
  categoryName: string | null;
  openingHours: Record<string, Array<{ open: string; close: string }>> | null;
  participatesInNetwork: boolean;
  zoneIds: string[];
  zoneNames: string[];
  allowCategoryIds: string[];
  blockCategoryIds: string[];
  excludedCompanyIds: string[];
  screenCount: number;
}

export interface Screen {
  id: string;
  companyId: string;
  companyName: string;
  locationId: string;
  locationName: string;
  displayName: string;
  status: string;
  health: string;
  platform: string | null;
  userAgent: string | null;
  resolution: string | null;
  supportsVideo: boolean | null;
  playerVersion: string | null;
  registeredAt: string;
  lastHeartbeatAt: string | null;
  lastPlaylistSyncAt: string | null;
  currentPlaylistVersion: number | null;
  latestPlaylistVersion: number | null;
  playbackState: string;
  lastError: string | null;
  lastErrorAt: string | null;
  lastPlaybackAt: string | null;
}

export interface Media {
  id: string;
  kind: 'IMAGE' | 'VIDEO';
  status: string;
  originalFilename: string;
  sizeBytes: number;
  width: number;
  height: number;
  durationMs: number | null;
  videoCodec: string | null;
  createdAt: string;
  thumbnailUrl: string | null;
  previewUrl: string;
  displaySeconds?: number;
}

export interface CampaignRow {
  id: string;
  companyId: string;
  companyName: string;
  isDevFixture: boolean;
  name: string;
  status: string;
  startAt: string;
  endAt: string;
  priority: number;
  submittedAt: string | null;
  updatedAt: string;
  mediaCount: number;
  playbackStarts: number;
}

export interface Schedule {
  days: number[];
  startMinute: number;
  endMinute: number;
}

export interface CampaignDetail {
  id: string;
  companyId: string;
  companyName: string;
  isDevFixture: boolean;
  name: string;
  description: string | null;
  status: string;
  startAt: string;
  endAt: string;
  priority: number;
  requestedPlaysPerDay: number | null;
  schedule: Schedule | null;
  targetZoneIds: string[];
  targetCategoryIds: string[];
  excludedCategoryIds: string[];
  submittedAt: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  media: Media[];
  reviews: Array<{ decision: string; fromStatus: string; toStatus: string; reason: string | null; createdAt: string; byName: string }>;
  capacity?: Capacity;
}

export interface Capacity {
  screens: Array<{ screenId: string; screenName: string; locationName: string; slotsPerLoop: number; loopSeconds: number; estimatedPlaysToday: number }>;
  estimatedPerDay: number;
  requestedPerDay: number | null;
  shortfallPerDay: number;
}

export interface SubscriptionState {
  subscription: {
    id: string;
    planCode: string;
    planName: string;
    status: string;
    source: 'STRIPE' | 'MANUAL';
    currentPeriodStart: string;
    currentPeriodEnd: string;
    cancelAtPeriodEnd: boolean;
  } | null;
  active: boolean;
  entitlements: Record<string, number>;
  playsThisPeriod: number;
}

export interface Plan {
  id: string;
  code: string;
  name: string;
  monthlyPriceCents: number;
  currency: string;
  priceIsDraft: boolean;
  onlineCheckout: boolean;
  stripePriceId: string | null;
  entitlements: Record<string, number>;
}

export interface PlaylistView {
  version: number | null;
  generatedAt?: string;
  validUntil?: string;
  items: Array<{ position: number; durationSec: number; notAfter: string; campaignId: string; campaignName: string; advertiserName: string; kind: string }>;
  decisions: Array<{
    campaignId: string;
    campaignName?: string;
    advertiserName?: string;
    eligible: boolean;
    reasons: string[];
    slots: number;
    displacedByCapacity?: boolean;
  }>;
  screenReasons: string[];
}

export const ENTITLEMENT_LABELS: Record<string, string> = {
  max_screens: 'Screens',
  max_active_campaigns: 'Active campaigns',
  max_target_zones: 'Target zones per campaign',
  monthly_playback_allocation: 'Playbacks per month',
  max_campaign_days: 'Max campaign length (days)',
  distribution_weight: 'Distribution weight',
  reporting_level: 'Reporting level',
};
