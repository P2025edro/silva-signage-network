import { isLocationOpen, isWithinSchedule } from './time.js';
import type {
  CampaignCandidate,
  CampaignIneligibilityReason,
  DistributionPolicy,
  MediaCandidate,
  ScreenContext,
  ScreenIneligibilityReason,
  SubscriptionSnapshot,
} from './types.js';

/** Statuses from which an approved campaign may play, subject to its dates. */
const PLAYABLE_STATUSES = new Set(['APPROVED', 'SCHEDULED', 'ACTIVE']);
/** Codec every delivery rendition is transcoded to. */
export const DELIVERY_VIDEO_CODEC = 'h264';

export function isSubscriptionActive(sub: SubscriptionSnapshot | null, now: Date): boolean {
  if (!sub) return false;
  return (sub.status === 'ACTIVE' || sub.status === 'TRIALING') && sub.currentPeriodEnd.getTime() > now.getTime();
}

/** Checks that apply to the screen regardless of which campaign is considered. */
export function screenIneligibility(
  screen: ScreenContext,
  policy: DistributionPolicy,
  now: Date,
): ScreenIneligibilityReason[] {
  const reasons: ScreenIneligibilityReason[] = [];
  if (screen.screenStatus !== 'ACTIVE') reasons.push('SCREEN_NOT_ACTIVE');
  if (screen.hostStatus !== 'ACTIVE') reasons.push('HOST_SUSPENDED');
  if (policy.requireHostSubscription && !screen.hostSubscriptionActive) reasons.push('HOST_SUBSCRIPTION_INACTIVE');
  if (!screen.participatesInNetwork) reasons.push('LOCATION_NOT_PARTICIPATING');
  if (!isLocationOpen(screen.openingHours, now, screen.timezone)) reasons.push('LOCATION_CLOSED');
  return reasons;
}

/** Media this screen can play, in campaign order. */
export function compatibleMedia(
  campaign: CampaignCandidate,
  screen: ScreenContext,
  policy: DistributionPolicy,
): MediaCandidate[] {
  return campaign.media
    .filter((m) => {
      if (m.status !== 'READY') return false;
      if (m.kind === 'IMAGE') return true;
      if (screen.supportsVideo === false) return false;
      if (m.videoCodec !== DELIVERY_VIDEO_CODEC) return false;
      if (m.durationMs === null || m.durationMs <= 0) return false;
      return m.durationMs <= policy.maxVideoSeconds * 1000;
    })
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}

/**
 * Every rule a campaign must satisfy to be placed on a screen. Returns all
 * failing reasons (not just the first) so operators can see the full picture.
 */
export function campaignIneligibility(
  campaign: CampaignCandidate,
  screen: ScreenContext,
  policy: DistributionPolicy,
  now: Date,
): CampaignIneligibilityReason[] {
  const reasons: CampaignIneligibilityReason[] = [];

  // Campaign state and timing
  if (!PLAYABLE_STATUSES.has(campaign.status)) reasons.push('CAMPAIGN_NOT_APPROVED');
  if (now.getTime() < campaign.startAt.getTime()) reasons.push('BEFORE_START');
  if (now.getTime() >= campaign.endAt.getTime()) reasons.push('AFTER_END');
  if (!isWithinSchedule(campaign.schedule, now, screen.timezone)) reasons.push('OUTSIDE_SCHEDULE');

  // Advertiser standing and entitlements
  if (campaign.advertiserStatus !== 'ACTIVE') reasons.push('ADVERTISER_SUSPENDED');
  const sub = campaign.advertiserSubscription;
  if (!isSubscriptionActive(sub, now)) {
    reasons.push('SUBSCRIPTION_INACTIVE');
  } else if (sub && campaign.advertiserPlaysThisPeriod >= sub.monthlyPlaybackAllocation) {
    reasons.push('QUOTA_EXHAUSTED');
  }

  // Network policy
  if (!policy.allowOwnScreens && campaign.companyId === screen.companyId) reasons.push('OWN_SCREEN');

  // Advertiser targeting
  if (campaign.targetZoneIds.length > 0 && !campaign.targetZoneIds.some((z) => screen.zoneIds.includes(z))) {
    reasons.push('ZONE_MISMATCH');
  }
  if (
    campaign.targetVenueCategoryIds.length > 0 &&
    (screen.venueCategoryId === null || !campaign.targetVenueCategoryIds.includes(screen.venueCategoryId))
  ) {
    reasons.push('VENUE_CATEGORY_NOT_TARGETED');
  }
  if (screen.venueCategoryId !== null && campaign.excludedVenueCategoryIds.includes(screen.venueCategoryId)) {
    reasons.push('VENUE_CATEGORY_EXCLUDED');
  }

  // Host competition rules. Conflict resolution: a specific advertiser exclusion
  // and a category BLOCK both override any ALLOW rule.
  if (screen.excludedAdvertiserIds.includes(campaign.companyId)) reasons.push('ADVERTISER_EXCLUDED_BY_HOST');
  const cat = campaign.advertiserCategoryId;
  if (cat !== null && screen.blockedCategoryIds.includes(cat)) {
    reasons.push('CATEGORY_BLOCKED_BY_HOST');
  } else if (screen.allowedCategoryIds.length > 0 && (cat === null || !screen.allowedCategoryIds.includes(cat))) {
    reasons.push('CATEGORY_NOT_ALLOWED_BY_HOST');
  }

  if (compatibleMedia(campaign, screen, policy).length === 0) reasons.push('NO_COMPATIBLE_MEDIA');

  return reasons;
}
