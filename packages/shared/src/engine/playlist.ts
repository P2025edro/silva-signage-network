import { allocateLoop, type AllocationCandidate } from './allocation.js';
import { campaignIneligibility, compatibleMedia, screenIneligibility } from './eligibility.js';
import { nextQuarterHour, openMinutesOnDay } from './time.js';
import type {
  CampaignCandidate,
  CampaignDecision,
  DistributionPolicy,
  GeneratedPlaylist,
  MediaCandidate,
  OpeningHours,
  PlaylistItem,
  ScreenContext,
} from './types.js';

const QUARTER_MS = 15 * 60 * 1000;

function itemSeconds(m: MediaCandidate): number {
  return m.kind === 'VIDEO' ? Math.ceil((m.durationMs ?? 0) / 1000) : m.displaySeconds;
}

/**
 * Builds one screen's playlist from a snapshot of candidate campaigns.
 * Pure: the same inputs (including `now`) always produce the same playlist.
 */
export function buildScreenPlaylist(
  screen: ScreenContext,
  campaigns: CampaignCandidate[],
  policy: DistributionPolicy,
  now: Date,
): GeneratedPlaylist {
  const screenReasons = screenIneligibility(screen, policy, now);
  let validUntil = nextQuarterHour(now);

  if (screenReasons.length > 0) {
    return {
      screenId: screen.screenId,
      items: [],
      decisions: campaigns.map((c) => ({ campaignId: c.id, eligible: false, reasons: [...screenReasons], slots: 0 })),
      screenReasons,
      loopSeconds: 0,
      validUntil,
      fingerprint: `fallback|${screenReasons.join(',')}`,
    };
  }

  const decisions: CampaignDecision[] = [];
  const eligible: Array<{ campaign: CampaignCandidate; media: MediaCandidate[] }> = [];

  for (const campaign of [...campaigns].sort((a, b) => a.id.localeCompare(b.id))) {
    const reasons = campaignIneligibility(campaign, screen, policy, now);
    decisions.push({ campaignId: campaign.id, eligible: reasons.length === 0, reasons, slots: 0 });
    if (reasons.length === 0) eligible.push({ campaign, media: compatibleMedia(campaign, screen, policy) });

    // A playable campaign that starts before the next regeneration shortens validity.
    const onlyWaitingToStart = reasons.length === 1 && reasons[0] === 'BEFORE_START';
    if (onlyWaitingToStart && campaign.startAt < validUntil) validUntil = campaign.startAt;
  }

  const candidates: AllocationCandidate[] = eligible.map(({ campaign, media }) => {
    const sub = campaign.advertiserSubscription!;
    return {
      campaignId: campaign.id,
      advertiserId: campaign.companyId,
      weight: Math.max(1, sub.distributionWeight) * campaign.priority,
      deliveryRatio: sub.monthlyPlaybackAllocation > 0 ? campaign.advertiserPlaysThisPeriod / sub.monthlyPlaybackAllocation : 1,
      creativeCount: media.length,
    };
  });
  const allocation = allocateLoop(candidates, policy.slotsPerLoop, policy.maxAdvertiserShare);

  for (const d of decisions) {
    d.slots = allocation.slots.get(d.campaignId) ?? 0;
    if (allocation.displaced.includes(d.campaignId)) d.displacedByCapacity = true;
  }

  // Creative rotation: each quarter-hour shifts which creative a campaign's
  // first slot uses, so campaigns with more creatives than slots still rotate.
  const rotation = Math.floor(now.getTime() / QUARTER_MS);
  const byId = new Map(eligible.map((e) => [e.campaign.id, e]));
  const seen = new Map<string, number>();
  const items: PlaylistItem[] = allocation.order.map((campaignId, position) => {
    const { campaign, media } = byId.get(campaignId)!;
    const k = seen.get(campaignId) ?? 0;
    seen.set(campaignId, k + 1);
    const creative = media[(k + rotation) % media.length]!;
    if (campaign.endAt < validUntil) validUntil = campaign.endAt;
    return {
      position,
      campaignId,
      advertiserCompanyId: campaign.companyId,
      mediaAssetId: creative.id,
      durationSec: itemSeconds(creative),
      notAfter: campaign.endAt,
      schedule: campaign.schedule,
    };
  });

  const loopSeconds = items.reduce((sum, i) => sum + i.durationSec, 0);
  const fingerprint = items
    .map((i) => `${i.campaignId}:${i.mediaAssetId}:${i.durationSec}:${i.notAfter.toISOString()}:${JSON.stringify(i.schedule)}`)
    .join('|');

  return { screenId: screen.screenId, items, decisions, screenReasons, loopSeconds, validUntil, fingerprint: fingerprint || 'fallback' };
}

/**
 * Rough plays/day a campaign gets from one screen, given its share of the loop.
 * An estimate for capacity planning, not a delivery promise: real delivery
 * depends on the TV being on and the player running.
 */
export function estimateDailyPlays(args: {
  slotsInLoop: number;
  loopSeconds: number;
  openingHours: OpeningHours | null;
  isoWeekday: number;
}): number {
  if (args.loopSeconds <= 0 || args.slotsInLoop <= 0) return 0;
  const openSeconds = openMinutesOnDay(args.openingHours, args.isoWeekday) * 60;
  return Math.floor((openSeconds / args.loopSeconds) * args.slotsInLoop);
}

/** Positive = requested delivery the network cannot currently provide. */
export function deliveryShortfall(requestedPerDay: number | null, estimatedPerDay: number): number {
  if (requestedPerDay === null) return 0;
  return Math.max(0, requestedPerDay - estimatedPerDay);
}
