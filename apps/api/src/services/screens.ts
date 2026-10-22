import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';

export type ScreenHealth = 'DISABLED' | 'NEVER_CONNECTED' | 'OFFLINE' | 'ERROR' | 'STALLED' | 'SYNC_PENDING' | 'PLAYING' | 'ONLINE';

export interface HealthInput {
  status: string;
  last_heartbeat_at: Date | null;
  playback_state: string;
  current_playlist_version: number | null;
  latest_playlist_version: number | null;
  latest_item_count: number;
  last_playback_at: Date | null;
}

const STALL_MS = 5 * 60 * 1000;

/**
 * Derived from the last heartbeat. Thresholds come from platform settings:
 * heartbeat every `heartbeat_interval_seconds`, offline after `offline_after_seconds`.
 */
export function screenHealth(s: HealthInput, now: Date, offlineAfterSeconds: number): ScreenHealth {
  if (s.status !== 'ACTIVE') return 'DISABLED';
  if (!s.last_heartbeat_at) return 'NEVER_CONNECTED';
  if (now.getTime() - s.last_heartbeat_at.getTime() > offlineAfterSeconds * 1000) return 'OFFLINE';
  if (s.playback_state === 'ERROR') return 'ERROR';
  const shouldBePlaying = s.latest_item_count > 0;
  const noRecentPlayback = !s.last_playback_at || now.getTime() - s.last_playback_at.getTime() > STALL_MS;
  if (s.playback_state === 'STALLED' || (s.playback_state === 'PLAYING' && shouldBePlaying && noRecentPlayback)) return 'STALLED';
  if (s.latest_playlist_version !== null && (s.current_playlist_version ?? 0) < s.latest_playlist_version) return 'SYNC_PENDING';
  return s.playback_state === 'PLAYING' ? 'PLAYING' : 'ONLINE';
}

export const SCREEN_SELECT = (db: Db) => db`
  SELECT sc.id, sc.company_id, co.name AS company_name, sc.location_id, l.name AS location_name, sc.display_name, sc.status,
    sc.platform, sc.user_agent, sc.screen_width, sc.screen_height, sc.supports_video, sc.player_version, sc.registered_at,
    sc.last_heartbeat_at, sc.last_playlist_sync_at, sc.current_playlist_version, sc.playback_state, sc.last_error, sc.last_error_at,
    sc.last_playback_at, p.version AS latest_playlist_version, COALESCE(p.item_count, 0)::int AS latest_item_count
  FROM screens sc
  JOIN locations l ON l.id = sc.location_id
  JOIN companies co ON co.id = sc.company_id
  LEFT JOIN LATERAL (
    SELECT sp.version, (SELECT count(*) FROM playlist_items pi WHERE pi.playlist_id = sp.id) AS item_count
    FROM screen_playlists sp WHERE sp.screen_id = sc.id ORDER BY sp.version DESC LIMIT 1
  ) p ON true`;

export function presentScreen(row: Record<string, unknown>, now: Date, offlineAfterSeconds: number) {
  const r = row as unknown as HealthInput & Record<string, unknown>;
  return {
    id: r.id,
    companyId: r.company_id,
    companyName: r.company_name,
    locationId: r.location_id,
    locationName: r.location_name,
    displayName: r.display_name,
    status: r.status,
    health: screenHealth(r, now, offlineAfterSeconds),
    platform: r.platform,
    userAgent: r.user_agent,
    resolution: r.screen_width && r.screen_height ? `${r.screen_width}×${r.screen_height}` : null,
    supportsVideo: r.supports_video,
    playerVersion: r.player_version,
    registeredAt: r.registered_at,
    lastHeartbeatAt: r.last_heartbeat_at,
    lastPlaylistSyncAt: r.last_playlist_sync_at,
    currentPlaylistVersion: r.current_playlist_version,
    latestPlaylistVersion: r.latest_playlist_version,
    playbackState: r.playback_state,
    lastError: r.last_error,
    lastErrorAt: r.last_error_at,
    lastPlaybackAt: r.last_playback_at,
  };
}

export const COMMAND_TYPES = ['REFRESH_PLAYLIST', 'REFRESH_CONFIG', 'RELOAD_PLAYER', 'REPORT_DIAGNOSTICS'] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

/** Idempotent: the same key for the same screen returns the existing command. */
export async function issueCommand(
  db: Db,
  args: { screenId: string; type: CommandType; userId: string; companyId: string; idempotencyKey?: string; ip: string; now: Date },
) {
  const key = args.idempotencyKey ?? randomUUID();
  const [cmd] = await db<{ id: string; status: string }[]>`
    INSERT INTO screen_commands (screen_id, type, idempotency_key, issued_by, expires_at)
    VALUES (${args.screenId}, ${args.type}, ${key}, ${args.userId}, ${new Date(args.now.getTime() + 10 * 60_000)})
    ON CONFLICT (screen_id, idempotency_key) DO NOTHING RETURNING id, status`;
  if (!cmd) {
    const [existing] = await db<
      { id: string; status: string }[]
    >`SELECT id, status FROM screen_commands WHERE screen_id = ${args.screenId} AND idempotency_key = ${key}`;
    return { ...existing!, duplicate: true };
  }
  await audit(db, {
    actorType: 'USER',
    actorId: args.userId,
    companyId: args.companyId,
    action: 'screen.command_issued',
    entityType: 'screen',
    entityId: args.screenId,
    metadata: { type: args.type, commandId: cmd.id },
    ip: args.ip,
  });
  return { ...cmd, duplicate: false };
}

export async function unpairScreen(db: Db, args: { screenId: string; companyId: string; userId: string; ip: string; now: Date }) {
  const [s] = await db`UPDATE screens SET status = 'UNPAIRED', deleted_at = ${args.now}, updated_at = ${args.now}
    WHERE id = ${args.screenId} AND company_id = ${args.companyId} AND deleted_at IS NULL RETURNING id`;
  if (!s) throw notFound('Screen');
  await db`UPDATE device_credentials SET revoked_at = ${args.now}, revoked_reason = 'unpaired' WHERE screen_id = ${args.screenId} AND revoked_at IS NULL`;
  await db`UPDATE screen_commands SET status = 'EXPIRED' WHERE screen_id = ${args.screenId} AND status IN ('PENDING', 'DELIVERED')`;
  await audit(db, {
    actorType: 'USER',
    actorId: args.userId,
    companyId: args.companyId,
    action: 'screen.unpaired',
    entityType: 'screen',
    entityId: args.screenId,
    ip: args.ip,
  });
}

export function assertCommandType(type: string): asserts type is CommandType {
  if (!(COMMAND_TYPES as readonly string[]).includes(type)) throw badRequest('Unknown command');
}
