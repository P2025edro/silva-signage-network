import {
  buildScreenPlaylist,
  type CampaignCandidate,
  type GeneratedPlaylist,
  type MediaCandidate,
  type OpeningHours,
  type ScreenContext,
  type WeeklySchedule,
} from '@silva/shared';
import type { Db, Sql } from '../db.js';
import { sha256 } from '../lib/crypto.js';
import type { Deps } from '../types.js';
import { distributionPolicy, getSettings } from './settings.js';

const PLAYABLE = ['APPROVED', 'SCHEDULED', 'ACTIVE'];
const LIVE_SUBSCRIPTION = ['INCOMPLETE', 'TRIALING', 'ACTIVE', 'PAST_DUE'];

interface CampaignRow {
  id: string;
  name: string;
  company_id: string;
  status: CampaignCandidate['status'];
  start_at: Date;
  end_at: Date;
  priority: number;
  schedule: WeeklySchedule | null;
  advertiser_status: CampaignCandidate['advertiserStatus'];
  advertiser_category_id: string | null;
  sub_status: NonNullable<CampaignCandidate['advertiserSubscription']>['status'] | null;
  sub_period_end: Date | null;
  allocation: number;
  weight: number;
  plays: number;
  zone_ids: string[];
  target_category_ids: string[];
  excluded_category_ids: string[];
  media: Array<{
    id: string;
    kind: 'IMAGE' | 'VIDEO';
    status: MediaCandidate['status'];
    display_seconds: number;
    duration_ms: number | null;
    video_codec: string | null;
    position: number;
  }>;
}

/** Campaign snapshot for the engine. One query; scales to the MVP network size. */
export async function loadCampaignCandidates(db: Db, now: Date, campaignIds?: string[]): Promise<CampaignCandidate[]> {
  const rows = await db<CampaignRow[]>`
    SELECT c.id, c.name, c.company_id, c.status, c.start_at, c.end_at, c.priority, c.schedule,
      co.status AS advertiser_status, co.category_id AS advertiser_category_id,
      s.status AS sub_status, s.current_period_end AS sub_period_end,
      COALESCE((SELECT value FROM plan_entitlements WHERE plan_id = s.plan_id AND key = 'monthly_playback_allocation'), 0) AS allocation,
      COALESCE((SELECT value FROM plan_entitlements WHERE plan_id = s.plan_id AND key = 'distribution_weight'), 1) AS weight,
      COALESCE((SELECT count(*) FROM playback_events pe
                WHERE pe.advertiser_company_id = c.company_id AND pe.type = 'STARTED'
                  AND pe.occurred_at >= s.current_period_start), 0)::int AS plays,
      ARRAY(SELECT zone_id::text FROM campaign_targeting WHERE campaign_id = c.id) AS zone_ids,
      ARRAY(SELECT category_id::text FROM campaign_target_categories WHERE campaign_id = c.id) AS target_category_ids,
      ARRAY(SELECT category_id::text FROM campaign_exclusions WHERE campaign_id = c.id) AS excluded_category_ids,
      COALESCE((
        SELECT json_agg(json_build_object(
          'id', m.id, 'kind', m.kind, 'status', m.status, 'display_seconds', cm.display_seconds,
          'duration_ms', m.duration_ms, 'video_codec', m.video_codec, 'position', cm.position))
        FROM campaign_media cm JOIN media_assets m ON m.id = cm.media_asset_id AND m.deleted_at IS NULL
        WHERE cm.campaign_id = c.id), '[]'::json) AS media
    FROM campaigns c
    JOIN companies co ON co.id = c.company_id AND co.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT * FROM subscriptions s WHERE s.company_id = c.company_id AND s.status = ANY(${LIVE_SUBSCRIPTION}::subscription_status[])
      ORDER BY s.created_at DESC LIMIT 1
    ) s ON true
    WHERE c.deleted_at IS NULL AND c.status = ANY(${PLAYABLE}::campaign_status[]) AND c.end_at > ${now}
      ${campaignIds ? db`AND c.id = ANY(${campaignIds}::uuid[])` : db``}`;

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    companyId: r.company_id,
    advertiserStatus: r.advertiser_status,
    advertiserCategoryId: r.advertiser_category_id,
    advertiserSubscription: r.sub_status
      ? {
          status: r.sub_status,
          currentPeriodEnd: r.sub_period_end!,
          monthlyPlaybackAllocation: r.allocation,
          distributionWeight: r.weight,
        }
      : null,
    advertiserPlaysThisPeriod: r.plays,
    status: r.status,
    startAt: r.start_at,
    endAt: r.end_at,
    priority: r.priority,
    schedule: r.schedule,
    targetZoneIds: r.zone_ids,
    targetVenueCategoryIds: r.target_category_ids,
    excludedVenueCategoryIds: r.excluded_category_ids,
    media: r.media.map((m) => ({
      id: m.id,
      kind: m.kind,
      status: m.status,
      displaySeconds: m.display_seconds,
      durationMs: m.duration_ms,
      videoCodec: m.video_codec,
      position: m.position,
    })),
  }));
}

interface ScreenRow {
  id: string;
  company_id: string;
  location_id: string;
  status: ScreenContext['screenStatus'];
  supports_video: boolean | null;
  host_status: ScreenContext['hostStatus'];
  host_sub_active: boolean;
  participates_in_network: boolean;
  category_id: string | null;
  timezone: string;
  opening_hours: OpeningHours | null;
  zone_ids: string[];
  allowed: string[];
  blocked: string[];
  excluded_advertisers: string[];
}

export async function loadScreenContexts(db: Db, now: Date, screenIds?: string[]): Promise<ScreenContext[]> {
  const rows = await db<ScreenRow[]>`
    SELECT sc.id, sc.company_id, sc.location_id, sc.status, sc.supports_video,
      co.status AS host_status,
      EXISTS (SELECT 1 FROM subscriptions s WHERE s.company_id = sc.company_id
              AND s.status IN ('ACTIVE', 'TRIALING') AND s.current_period_end > ${now}) AS host_sub_active,
      l.participates_in_network, l.category_id, l.timezone, l.opening_hours,
      ARRAY(SELECT zone_id::text FROM location_zones WHERE location_id = l.id) AS zone_ids,
      ARRAY(SELECT category_id::text FROM location_category_rules WHERE location_id = l.id AND kind = 'ALLOW') AS allowed,
      ARRAY(SELECT category_id::text FROM location_category_rules WHERE location_id = l.id AND kind = 'BLOCK') AS blocked,
      ARRAY(SELECT excluded_company_id::text FROM location_advertiser_exclusions WHERE location_id = l.id) AS excluded_advertisers
    FROM screens sc
    JOIN locations l ON l.id = sc.location_id
    JOIN companies co ON co.id = sc.company_id
    WHERE sc.deleted_at IS NULL AND l.deleted_at IS NULL
      ${screenIds ? db`AND sc.id = ANY(${screenIds}::uuid[])` : db``}`;
  return rows.map((r) => ({
    screenId: r.id,
    companyId: r.company_id,
    hostStatus: r.host_status,
    hostSubscriptionActive: r.host_sub_active,
    screenStatus: r.status,
    locationId: r.location_id,
    participatesInNetwork: r.participates_in_network,
    venueCategoryId: r.category_id,
    zoneIds: r.zone_ids,
    timezone: r.timezone,
    openingHours: r.opening_hours,
    allowedCategoryIds: r.allowed,
    blockedCategoryIds: r.blocked,
    excludedAdvertiserIds: r.excluded_advertisers,
    supportsVideo: r.supports_video,
  }));
}

export interface PersistResult {
  screenId: string;
  version: number;
  changed: boolean;
}

async function persistPlaylist(sql: Sql, g: GeneratedPlaylist): Promise<PersistResult> {
  const checksum = sha256(g.fingerprint).toString('hex');
  return sql.begin(async (tx) => {
    // Serialise generation per screen so versions stay monotonic.
    await tx`SELECT id FROM screens WHERE id = ${g.screenId} FOR UPDATE`;
    const [latest] = await tx<{ id: string; version: number; checksum: string }[]>`
      SELECT id, version, checksum FROM screen_playlists WHERE screen_id = ${g.screenId} ORDER BY version DESC LIMIT 1`;
    const decisions = tx.json({ screenReasons: g.screenReasons, campaigns: g.decisions } as never);

    if (latest && latest.checksum === checksum) {
      await tx`UPDATE screen_playlists SET valid_until = ${g.validUntil}, decisions = ${decisions} WHERE id = ${latest.id}`;
      return { screenId: g.screenId, version: latest.version, changed: false };
    }

    const version = (latest?.version ?? 0) + 1;
    const [pl] = await tx<{ id: string }[]>`
      INSERT INTO screen_playlists (screen_id, version, checksum, valid_until, decisions)
      VALUES (${g.screenId}, ${version}, ${checksum}, ${g.validUntil}, ${decisions}) RETURNING id`;
    if (g.items.length > 0) {
      await tx`INSERT INTO playlist_items ${tx(
        g.items.map((i) => ({
          playlist_id: pl!.id,
          position: i.position,
          campaign_id: i.campaignId,
          media_asset_id: i.mediaAssetId,
          duration_sec: i.durationSec,
          not_after: i.notAfter,
          is_fallback: false,
        })),
      )}`;
      const slots = new Map<string, number>();
      for (const i of g.items) slots.set(i.campaignId, (slots.get(i.campaignId) ?? 0) + 1);
      await tx`INSERT INTO delivery_allocations ${tx(
        [...slots].map(([campaign_id, slots_per_loop]) => ({
          playlist_id: pl!.id,
          campaign_id,
          screen_id: g.screenId,
          slots_per_loop,
          loop_seconds: g.loopSeconds,
        })),
      )}`;
    }
    return { screenId: g.screenId, version, changed: true };
  });
}

/** Regenerates playlists for the given screens (default: all). Called by workers and after campaign changes. */
export async function regeneratePlaylists(deps: Deps, screenIds?: string[]): Promise<PersistResult[]> {
  const now = deps.now();
  const settings = await getSettings(deps.sql);
  const policy = distributionPolicy(settings, deps.config.MEDIA_MAX_VIDEO_SECONDS);
  const [campaigns, screens] = await Promise.all([loadCampaignCandidates(deps.sql, now), loadScreenContexts(deps.sql, now, screenIds)]);
  const results: PersistResult[] = [];
  for (const screen of screens) {
    results.push(await persistPlaylist(deps.sql, buildScreenPlaylist(screen, campaigns, policy, now)));
  }
  return results;
}

/** Screens whose current playlist has expired (or never existed). */
export async function screensNeedingRegeneration(db: Db, now: Date): Promise<string[]> {
  const rows = await db<{ id: string }[]>`
    SELECT sc.id FROM screens sc
    LEFT JOIN LATERAL (SELECT valid_until FROM screen_playlists p WHERE p.screen_id = sc.id ORDER BY version DESC LIMIT 1) p ON true
    WHERE sc.deleted_at IS NULL AND (p.valid_until IS NULL OR p.valid_until <= ${now})`;
  return rows.map((r) => r.id);
}

export interface DevicePlaylist {
  version: number;
  checksum: string;
  generatedAt: Date;
  validUntil: Date;
  items: Array<{
    position: number;
    campaignId: string;
    mediaAssetId: string;
    kind: 'IMAGE' | 'VIDEO';
    mime: string;
    url: string;
    durationSec: number;
    notAfter: Date;
    schedule: WeeklySchedule | null;
    timezone: string;
  }>;
}

/** Latest playlist for a device, regenerating first if it has expired. */
export async function currentPlaylistForScreen(deps: Deps, screenId: string): Promise<DevicePlaylist> {
  const now = deps.now();
  const [latest] = await deps.sql<{ valid_until: Date }[]>`
    SELECT valid_until FROM screen_playlists WHERE screen_id = ${screenId} ORDER BY version DESC LIMIT 1`;
  if (!latest || latest.valid_until <= now) await regeneratePlaylists(deps, [screenId]);

  const [pl] = await deps.sql<{ id: string; version: number; checksum: string; generated_at: Date; valid_until: Date }[]>`
    SELECT id, version, checksum, generated_at, valid_until FROM screen_playlists
    WHERE screen_id = ${screenId} ORDER BY version DESC LIMIT 1`;
  if (!pl) throw new Error('Playlist generation failed');

  const settings = await getSettings(deps.sql);
  const offlineMs = settings['devices.offline_cache_max_hours'] * 3600_000;
  const rows = await deps.sql<
    {
      position: number;
      campaign_id: string;
      media_asset_id: string;
      kind: 'IMAGE' | 'VIDEO';
      storage_key: string;
      duration_sec: number;
      not_after: Date;
      schedule: WeeklySchedule | null;
      timezone: string;
    }[]
  >`
    SELECT pi.position, pi.campaign_id, pi.media_asset_id, m.kind, m.storage_key, pi.duration_sec, pi.not_after, c.schedule, l.timezone
    FROM playlist_items pi
    JOIN media_assets m ON m.id = pi.media_asset_id
    JOIN campaigns c ON c.id = pi.campaign_id
    JOIN screens sc ON sc.id = ${screenId}
    JOIN locations l ON l.id = sc.location_id
    WHERE pi.playlist_id = ${pl.id} AND NOT pi.is_fallback
    ORDER BY pi.position`;

  const items = await Promise.all(
    rows.map(async (r) => {
      // URLs outlive the online window just enough for offline playback, never past the campaign end.
      const urlExpiry = new Date(Math.min(r.not_after.getTime(), now.getTime() + offlineMs));
      return {
        position: r.position,
        campaignId: r.campaign_id,
        mediaAssetId: r.media_asset_id,
        kind: r.kind,
        mime: r.kind === 'VIDEO' ? 'video/mp4' : 'image/jpeg',
        url: await deps.storage.signedUrl(r.storage_key, urlExpiry),
        durationSec: r.duration_sec,
        notAfter: r.not_after,
        schedule: r.schedule,
        timezone: r.timezone,
      };
    }),
  );
  return { version: pl.version, checksum: pl.checksum, generatedAt: pl.generated_at, validUntil: pl.valid_until, items };
}
