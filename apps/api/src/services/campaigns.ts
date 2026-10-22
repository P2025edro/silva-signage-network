import { deliveryShortfall, estimateDailyPlays, localParts, type OpeningHours } from '@silva/shared';
import type { Db } from '../db.js';
import { notFound } from '../lib/errors.js';
import { presentMedia } from './media.js';
import type { Deps } from '../types.js';

export async function loadCampaignDetail(deps: Deps, campaignId: string, companyId: string | null) {
  const [c] = await deps.sql`
    SELECT c.*, co.name AS company_name, co.is_dev_fixture,
      ARRAY(SELECT zone_id FROM campaign_targeting WHERE campaign_id = c.id) AS zone_ids,
      ARRAY(SELECT category_id FROM campaign_target_categories WHERE campaign_id = c.id) AS target_category_ids,
      ARRAY(SELECT category_id FROM campaign_exclusions WHERE campaign_id = c.id) AS excluded_category_ids
    FROM campaigns c JOIN companies co ON co.id = c.company_id
    WHERE c.id = ${campaignId} AND c.deleted_at IS NULL ${companyId ? deps.sql`AND c.company_id = ${companyId}` : deps.sql``}`;
  if (!c) throw notFound('Campaign');
  const mediaRows = await deps.sql`
    SELECT m.*, cm.display_seconds, cm.position FROM campaign_media cm JOIN media_assets m ON m.id = cm.media_asset_id
    WHERE cm.campaign_id = ${campaignId} ORDER BY cm.position`;
  const presented = await presentMedia(deps, mediaRows);
  const reviews = await deps.sql`
    SELECT r.decision, r.from_status AS "fromStatus", r.to_status AS "toStatus", r.reason, r.created_at AS "createdAt", u.full_name AS "byName"
    FROM campaign_reviews r JOIN users u ON u.id = r.reviewer_id WHERE r.campaign_id = ${campaignId} ORDER BY r.created_at DESC`;
  return {
    id: c.id,
    companyId: c.company_id,
    companyName: c.company_name,
    isDevFixture: c.is_dev_fixture,
    name: c.name,
    description: c.description,
    status: c.status,
    startAt: c.start_at,
    endAt: c.end_at,
    priority: c.priority,
    requestedPlaysPerDay: c.requested_plays_per_day,
    schedule: c.schedule,
    targetZoneIds: c.zone_ids,
    targetCategoryIds: c.target_category_ids,
    excludedCategoryIds: c.excluded_category_ids,
    submittedAt: c.submitted_at,
    reviewedAt: c.reviewed_at,
    reviewNote: c.review_note,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    media: presented.map((m, i) => ({ ...m, displaySeconds: mediaRows[i]!.display_seconds, position: mediaRows[i]!.position })),
    reviews,
  };
}

/** Current distribution of a campaign across the network and the gap against what was requested. */
export async function campaignCapacity(db: Db, campaignId: string, requestedPerDay: number | null, now: Date) {
  const rows = await db<
    {
      screen_id: string;
      display_name: string;
      location_name: string;
      slots_per_loop: number;
      loop_seconds: number;
      opening_hours: OpeningHours | null;
      timezone: string;
    }[]
  >`
    SELECT DISTINCT ON (sp.screen_id) sp.screen_id, s.display_name, l.name AS location_name, da.slots_per_loop, da.loop_seconds, l.opening_hours, l.timezone
    FROM screen_playlists sp
    JOIN screens s ON s.id = sp.screen_id AND s.deleted_at IS NULL
    JOIN locations l ON l.id = s.location_id
    LEFT JOIN delivery_allocations da ON da.playlist_id = sp.id AND da.campaign_id = ${campaignId}
    ORDER BY sp.screen_id, sp.version DESC`;
  const carrying = rows.filter((r) => r.slots_per_loop);
  const screens = carrying.map((r) => ({
    screenId: r.screen_id,
    screenName: r.display_name,
    locationName: r.location_name,
    slotsPerLoop: r.slots_per_loop,
    loopSeconds: r.loop_seconds,
    estimatedPlaysToday: estimateDailyPlays({
      slotsInLoop: r.slots_per_loop,
      loopSeconds: r.loop_seconds,
      openingHours: r.opening_hours,
      isoWeekday: localParts(now, r.timezone).isoWeekday,
    }),
  }));
  const estimatedPerDay = screens.reduce((s, x) => s + x.estimatedPlaysToday, 0);
  return { screens, estimatedPerDay, requestedPerDay, shortfallPerDay: deliveryShortfall(requestedPerDay, estimatedPerDay) };
}
