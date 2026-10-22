/**
 * Input and output types for the distribution engine.
 *
 * The engine is a set of pure functions: the API loads a snapshot from the
 * database, the engine decides, and the API persists the result. Nothing in
 * here touches I/O, the clock, or randomness, so every decision is
 * reproducible in tests.
 */

export type CampaignStatus =
  'DRAFT' | 'SUBMITTED' | 'UNDER_REVIEW' | 'CHANGES_REQUESTED' | 'APPROVED' | 'REJECTED' | 'SCHEDULED' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED';

export type SubscriptionStatus = 'INCOMPLETE' | 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | 'UNPAID';
export type AccountStatus = 'ACTIVE' | 'SUSPENDED' | 'PENDING';
export type ScreenStatus = 'ACTIVE' | 'DISABLED' | 'UNPAIRED';

/** Weekly window in the location's local time. days use ISO numbering: 1 = Monday … 7 = Sunday. */
export interface WeeklySchedule {
  days: number[];
  /** Minutes after local midnight, inclusive. Multiple of 15. */
  startMinute: number;
  /** Minutes after local midnight, exclusive. Multiple of 15, greater than startMinute, at most 1440. */
  endMinute: number;
}

export type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
/** "HH:MM" strings. close <= open means the interval runs past midnight. */
export type OpeningHours = Partial<Record<DayKey, Array<{ open: string; close: string }>>>;

export interface MediaCandidate {
  id: string;
  kind: 'IMAGE' | 'VIDEO';
  status: 'PROCESSING' | 'READY' | 'REJECTED';
  /** Seconds an image stays on screen. Ignored for video. */
  displaySeconds: number;
  durationMs: number | null;
  videoCodec: string | null;
  position: number;
}

export interface SubscriptionSnapshot {
  status: SubscriptionStatus;
  currentPeriodEnd: Date;
  monthlyPlaybackAllocation: number;
  distributionWeight: number;
}

export interface CampaignCandidate {
  id: string;
  name: string;
  /** Advertiser company. */
  companyId: string;
  advertiserStatus: AccountStatus;
  /** Category of the advertiser's business, used by host competition rules. */
  advertiserCategoryId: string | null;
  advertiserSubscription: SubscriptionSnapshot | null;
  /** Playback STARTED events recorded for this advertiser in its current subscription period. */
  advertiserPlaysThisPeriod: number;
  status: CampaignStatus;
  startAt: Date;
  endAt: Date;
  priority: number;
  schedule: WeeklySchedule | null;
  /** Empty = any zone. */
  targetZoneIds: string[];
  /** Empty = any venue category. */
  targetVenueCategoryIds: string[];
  excludedVenueCategoryIds: string[];
  media: MediaCandidate[];
}

export interface ScreenContext {
  screenId: string;
  /** Host company that owns the screen. */
  companyId: string;
  hostStatus: AccountStatus;
  hostSubscriptionActive: boolean;
  screenStatus: ScreenStatus;
  locationId: string;
  participatesInNetwork: boolean;
  venueCategoryId: string | null;
  zoneIds: string[];
  timezone: string;
  openingHours: OpeningHours | null;
  /** Host competition rules. */
  allowedCategoryIds: string[];
  blockedCategoryIds: string[];
  excludedAdvertiserIds: string[];
  /** null = the player has not reported this capability yet. */
  supportsVideo: boolean | null;
}

export interface DistributionPolicy {
  allowOwnScreens: boolean;
  /** 0 < share <= 1. Applied only when at least two advertisers are eligible. */
  maxAdvertiserShare: number;
  slotsPerLoop: number;
  requireHostSubscription: boolean;
  /** Longest video accepted into a playlist, in seconds. */
  maxVideoSeconds: number;
}

export const DEFAULT_POLICY: DistributionPolicy = {
  allowOwnScreens: false,
  maxAdvertiserShare: 0.4,
  slotsPerLoop: 12,
  requireHostSubscription: true,
  maxVideoSeconds: 60,
};

export type ScreenIneligibilityReason =
  'SCREEN_NOT_ACTIVE' | 'HOST_SUSPENDED' | 'HOST_SUBSCRIPTION_INACTIVE' | 'LOCATION_NOT_PARTICIPATING' | 'LOCATION_CLOSED';

export type CampaignIneligibilityReason =
  | 'CAMPAIGN_NOT_APPROVED'
  | 'BEFORE_START'
  | 'AFTER_END'
  | 'OUTSIDE_SCHEDULE'
  | 'ADVERTISER_SUSPENDED'
  | 'SUBSCRIPTION_INACTIVE'
  | 'QUOTA_EXHAUSTED'
  | 'OWN_SCREEN'
  | 'ZONE_MISMATCH'
  | 'VENUE_CATEGORY_NOT_TARGETED'
  | 'VENUE_CATEGORY_EXCLUDED'
  | 'ADVERTISER_EXCLUDED_BY_HOST'
  | 'CATEGORY_BLOCKED_BY_HOST'
  | 'CATEGORY_NOT_ALLOWED_BY_HOST'
  | 'NO_COMPATIBLE_MEDIA';

export type IneligibilityReason = ScreenIneligibilityReason | CampaignIneligibilityReason;

export interface CampaignDecision {
  campaignId: string;
  eligible: boolean;
  reasons: IneligibilityReason[];
  /** Slots this campaign received in the loop (0 if not eligible or not selected). */
  slots: number;
  /** Eligible but left out because the loop was full. */
  displacedByCapacity?: boolean;
}

export interface PlaylistItem {
  position: number;
  campaignId: string;
  advertiserCompanyId: string;
  mediaAssetId: string;
  durationSec: number;
  /** The player must not show this item after this instant, even from cache. */
  notAfter: Date;
  schedule: WeeklySchedule | null;
}

export interface GeneratedPlaylist {
  screenId: string;
  items: PlaylistItem[];
  /** Fallback-only when empty; the player shows the branded fallback screen. */
  decisions: CampaignDecision[];
  screenReasons: ScreenIneligibilityReason[];
  loopSeconds: number;
  /** Regenerate on or before this instant. */
  validUntil: Date;
  /** Deterministic description of the content; the API hashes it to detect changes. */
  fingerprint: string;
}
