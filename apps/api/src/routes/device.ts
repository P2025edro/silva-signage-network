import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { generatePairingCode, hashPairingCode, randomToken, sha256, verifyMediaSignature } from '../lib/crypto.js';
import { badRequest, HttpError, notFound, unauthorized } from '../lib/errors.js';
import { uuid } from '../lib/http.js';
import { currentPlaylistForScreen } from '../services/playlists.js';
import { getSettings } from '../services/settings.js';
import type { Deps, DeviceContext } from '../types.js';

const PLAYER_POLL_SECONDS = 60;
const EVENT_MAX_AGE_MS = 7 * 24 * 3600_000;
const EVENT_MAX_FUTURE_MS = 5 * 60_000;

async function requireDevice(req: FastifyRequest, deps: Deps): Promise<DeviceContext> {
  const header = req.headers.authorization ?? '';
  const m = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(header);
  if (!m) throw unauthorized('Device token required');
  const [row] = await deps.sql<{ credential_id: string; screen_id: string; company_id: string; location_id: string; last_used_at: Date | null }[]>`
    SELECT dc.id AS credential_id, s.id AS screen_id, s.company_id, s.location_id, dc.last_used_at
    FROM device_credentials dc JOIN screens s ON s.id = dc.screen_id
    WHERE dc.token_hash = ${sha256(m[1]!)} AND dc.revoked_at IS NULL AND s.deleted_at IS NULL`;
  if (!row) throw new HttpError(401, 'DEVICE_NOT_PAIRED', 'This screen is not paired');
  const now = deps.now();
  if (!row.last_used_at || now.getTime() - row.last_used_at.getTime() > 60_000) {
    await deps.sql`UPDATE device_credentials SET last_used_at = ${now} WHERE id = ${row.credential_id}`;
  }
  return { screenId: row.screen_id, companyId: row.company_id, locationId: row.location_id, credentialId: row.credential_id };
}

const PlaybackEvent = z.object({
  id: uuid,
  type: z.enum(['SCHEDULED', 'STARTED', 'COMPLETED', 'FAILED']),
  campaignId: uuid,
  mediaAssetId: uuid,
  playlistVersion: z.number().int().positive(),
  occurredAt: z.string().datetime(),
  error: z.string().max(500).nullish(),
});

const MEDIA_TYPES: Record<string, string> = { jpg: 'image/jpeg', mp4: 'video/mp4' };

export const deviceRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { deps } = app;

  // ---- Pairing ---------------------------------------------------------------
  r.post(
    '/api/device/pairing-sessions',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: { tags: ['device'], body: z.object({ platform: z.string().max(80).optional() }).optional() },
    },
    async (req, reply) => {
      const settings = await getSettings(deps.sql);
      const now = deps.now();
      const expiresAt = new Date(now.getTime() + settings['pairing.code_ttl_seconds'] * 1000);
      const pollSecret = randomToken(32);
      // Expire stale codes so their hashes can be reused.
      await deps.sql`UPDATE device_pairing_sessions SET status = 'EXPIRED' WHERE status = 'PENDING' AND expires_at <= ${now}`;
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = generatePairingCode();
        const [row] = await deps.sql<{ id: string }[]>`
          INSERT INTO device_pairing_sessions (code_hash, poll_secret_hash, expires_at, requester_ip, user_agent, created_at)
          VALUES (${hashPairingCode(deps.config.APP_SECRET, code)}, ${sha256(pollSecret)}, ${expiresAt}, ${req.ip}, ${req.headers['user-agent'] ?? null}, ${now})
          ON CONFLICT DO NOTHING RETURNING id`;
        if (row) {
          reply.status(201);
          return { id: row.id, code, pollSecret, expiresAt, pollIntervalSeconds: 3 };
        }
      }
      throw new HttpError(503, 'PAIRING_UNAVAILABLE', 'Could not allocate a pairing code. Try again.');
    },
  );

  r.get(
    '/api/device/pairing-sessions/:id',
    { config: { rateLimit: { max: 40, timeWindow: '1 minute' } }, schema: { tags: ['device'], params: z.object({ id: uuid }) } },
    async (req) => {
      const secret = req.headers['x-poll-secret'];
      if (typeof secret !== 'string' || !secret) throw unauthorized('Poll secret required');
      const now = deps.now();
      return deps.sql.begin(async (tx) => {
        const [s] = await tx<{ id: string; status: string; expires_at: Date; screen_id: string | null }[]>`
          SELECT id, status, expires_at, screen_id FROM device_pairing_sessions
          WHERE id = ${req.params.id} AND poll_secret_hash = ${sha256(secret)} FOR UPDATE`;
        if (!s) throw notFound('Pairing session');
        if (s.status === 'PENDING' && s.expires_at <= now) {
          await tx`UPDATE device_pairing_sessions SET status = 'EXPIRED' WHERE id = ${s.id}`;
          return { status: 'EXPIRED' };
        }
        if (s.status === 'CLAIMED' && s.screen_id) {
          const token = randomToken(32);
          await tx`INSERT INTO device_credentials (screen_id, token_hash) VALUES (${s.screen_id}, ${sha256(token)})`;
          await tx`UPDATE device_pairing_sessions SET status = 'DELIVERED', delivered_at = ${now} WHERE id = ${s.id}`;
          await audit(tx, {
            actorType: 'DEVICE',
            actorId: s.screen_id,
            action: 'device.credential_issued',
            entityType: 'screen',
            entityId: s.screen_id,
            ip: req.ip,
          });
          // The token is shown exactly once; only its hash is stored.
          return { status: 'PAIRED', token, screenId: s.screen_id };
        }
        return { status: s.status, expiresAt: s.expires_at };
      });
    },
  );

  // ---- Paired device ---------------------------------------------------------
  r.get('/api/device/config', { schema: { tags: ['device'] } }, async (req) => {
    const d = await requireDevice(req, deps);
    const settings = await getSettings(deps.sql);
    const [info] = await deps.sql`
      SELECT s.display_name, l.name AS location_name, c.name AS company_name, s.status
      FROM screens s JOIN locations l ON l.id = s.location_id JOIN companies c ON c.id = s.company_id WHERE s.id = ${d.screenId}`;
    return {
      screenId: d.screenId,
      displayName: info!.display_name,
      locationName: info!.location_name,
      companyName: info!.company_name,
      status: info!.status,
      heartbeatIntervalSeconds: settings['devices.heartbeat_interval_seconds'],
      playlistPollSeconds: PLAYER_POLL_SECONDS,
      offlineCacheMaxHours: settings['devices.offline_cache_max_hours'],
      serverTime: deps.now().toISOString(),
    };
  });

  r.get('/api/device/playlist', { schema: { tags: ['device'], querystring: z.object({ knownVersion: z.coerce.number().int().optional() }) } }, async (req) => {
    const d = await requireDevice(req, deps);
    const playlist = await currentPlaylistForScreen(deps, d.screenId);
    await deps.sql`UPDATE screens SET last_playlist_sync_at = ${deps.now()} WHERE id = ${d.screenId}`;
    if (req.query.knownVersion === playlist.version) {
      return { unchanged: true, version: playlist.version, validUntil: playlist.validUntil, serverTime: deps.now().toISOString() };
    }
    return { unchanged: false, ...playlist, serverTime: deps.now().toISOString() };
  });

  r.post(
    '/api/device/heartbeat',
    {
      schema: {
        tags: ['device'],
        body: z.object({
          playbackState: z.enum(['UNKNOWN', 'PLAYING', 'IDLE_FALLBACK', 'STALLED', 'ERROR']),
          playlistVersion: z.number().int().nullable(),
          error: z.string().max(500).nullish(),
          playerVersion: z.string().max(40),
          platform: z.string().max(80).nullish(),
          screenWidth: z.number().int().min(0).max(10000).nullish(),
          screenHeight: z.number().int().min(0).max(10000).nullish(),
          supportsVideo: z.boolean().nullish(),
          details: z.record(z.string(), z.unknown()).optional(),
        }),
      },
    },
    async (req) => {
      const d = await requireDevice(req, deps);
      const b = req.body;
      const now = deps.now();
      const ua = req.headers['user-agent'] ?? null;
      await deps.sql`
        UPDATE screens SET last_heartbeat_at = ${now}, playback_state = ${b.playbackState}, current_playlist_version = ${b.playlistVersion},
          player_version = ${b.playerVersion}, platform = COALESCE(${b.platform ?? null}, platform), user_agent = COALESCE(${ua}, user_agent),
          screen_width = COALESCE(${b.screenWidth ?? null}, screen_width), screen_height = COALESCE(${b.screenHeight ?? null}, screen_height),
          supports_video = COALESCE(${b.supportsVideo ?? null}, supports_video),
          last_error = CASE WHEN ${b.error ?? null}::text IS NOT NULL THEN ${b.error ?? null} ELSE last_error END,
          last_error_at = CASE WHEN ${b.error ?? null}::text IS NOT NULL THEN ${now} ELSE last_error_at END
        WHERE id = ${d.screenId}`;
      await deps.sql`INSERT INTO screen_heartbeats (screen_id, received_at, playback_state, playlist_version, error, details)
        VALUES (${d.screenId}, ${now}, ${b.playbackState}, ${b.playlistVersion}, ${b.error ?? null}, ${b.details ? deps.sql.json(b.details as never) : null})`;
      await deps.sql`UPDATE screen_commands SET status = 'EXPIRED' WHERE screen_id = ${d.screenId} AND status IN ('PENDING','DELIVERED') AND expires_at <= ${now}`;
      const commands = await deps.sql`
        UPDATE screen_commands SET status = 'DELIVERED', delivered_at = COALESCE(delivered_at, ${now})
        WHERE screen_id = ${d.screenId} AND status IN ('PENDING', 'DELIVERED') RETURNING id, type`;
      const [latest] = await deps.sql<
        { version: number }[]
      >`SELECT version FROM screen_playlists WHERE screen_id = ${d.screenId} ORDER BY version DESC LIMIT 1`;
      return { latestPlaylistVersion: latest?.version ?? null, commands, serverTime: now.toISOString() };
    },
  );

  r.post(
    '/api/device/commands/:id/ack',
    {
      schema: {
        tags: ['device'],
        params: z.object({ id: uuid }),
        body: z.object({ success: z.boolean(), result: z.record(z.string(), z.unknown()).optional() }),
      },
    },
    async (req) => {
      const d = await requireDevice(req, deps);
      const [c] = await deps.sql`
        UPDATE screen_commands SET status = ${req.body.success ? 'ACKNOWLEDGED' : 'FAILED'}, acknowledged_at = ${deps.now()},
          result = ${req.body.result ? deps.sql.json(req.body.result as never) : null}
        WHERE id = ${req.params.id} AND screen_id = ${d.screenId} AND status IN ('PENDING', 'DELIVERED') RETURNING id`;
      if (!c) throw notFound('Command');
      return { ok: true };
    },
  );

  r.post(
    '/api/device/playback-events',
    {
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: { tags: ['device'], body: z.object({ events: z.array(PlaybackEvent).min(1).max(200) }) },
    },
    async (req) => {
      const d = await requireDevice(req, deps);
      const now = deps.now();
      const events = req.body.events;
      const versions = [...new Set(events.map((e) => e.playlistVersion))];
      // Only campaign/media pairs that were actually in this screen's playlist version are accepted.
      const allowed = await deps.sql<{ version: number; campaign_id: string; media_asset_id: string; company_id: string }[]>`
        SELECT p.version, pi.campaign_id, pi.media_asset_id, c.company_id
        FROM screen_playlists p JOIN playlist_items pi ON pi.playlist_id = p.id JOIN campaigns c ON c.id = pi.campaign_id
        WHERE p.screen_id = ${d.screenId} AND p.version = ANY(${versions}::int[])`;
      const key = (v: number, c: string, m: string) => `${v}|${c}|${m}`;
      const advertiserOf = new Map(allowed.map((a) => [key(a.version, a.campaign_id, a.media_asset_id), a.company_id]));

      let rejected = 0;
      const rows = [];
      for (const e of events) {
        const at = new Date(e.occurredAt);
        const advertiser = advertiserOf.get(key(e.playlistVersion, e.campaignId, e.mediaAssetId));
        const age = now.getTime() - at.getTime();
        if (!advertiser || age > EVENT_MAX_AGE_MS || age < -EVENT_MAX_FUTURE_MS) {
          rejected++;
          continue;
        }
        rows.push({
          id: e.id,
          screen_id: d.screenId,
          campaign_id: e.campaignId,
          advertiser_company_id: advertiser,
          media_asset_id: e.mediaAssetId,
          playlist_version: e.playlistVersion,
          type: e.type,
          occurred_at: at,
          received_at: now,
          error: e.error ?? null,
        });
      }
      let accepted = 0;
      if (rows.length) {
        // Event ids come from the player, so retried batches are de-duplicated here.
        const inserted = await deps.sql`INSERT INTO playback_events ${deps.sql(rows)} ON CONFLICT (id) DO NOTHING RETURNING id`;
        accepted = inserted.length;
        const lastStart = rows.filter((r) => r.type === 'STARTED').reduce<Date | null>((m, r) => (!m || r.occurred_at > m ? r.occurred_at : m), null);
        if (lastStart)
          await deps.sql`UPDATE screens SET last_playback_at = GREATEST(COALESCE(last_playback_at, ${lastStart}), ${lastStart}) WHERE id = ${d.screenId}`;
      }
      if (rejected > 0) req.log.warn({ screenId: d.screenId, rejected }, 'Rejected playback events');
      return { accepted, duplicates: rows.length - accepted, rejected };
    },
  );

  // ---- Signed media (local storage driver) ----------------------------------
  r.get(
    '/api/media-files/*',
    { schema: { hide: true, querystring: z.object({ exp: z.coerce.number().int(), sig: z.string().max(100) }) } },
    async (req, reply) => {
      const key = (req.params as { '*': string })['*'];
      const { exp, sig } = req.query;
      if (exp * 1000 < deps.now().getTime() || !verifyMediaSignature(deps.config.APP_SECRET, key, exp, sig)) {
        throw new HttpError(403, 'URL_EXPIRED', 'This media link has expired');
      }
      if (!deps.storage.open) throw badRequest('Not available with this storage driver');
      const file = await deps.storage.open(key);
      if (!file) throw notFound('File');
      const type = MEDIA_TYPES[key.split('.').pop() ?? ''] ?? 'application/octet-stream';
      reply.header('Content-Type', type).header('Cache-Control', 'private, max-age=86400').header('Accept-Ranges', 'bytes');

      // Range support: many TV video decoders require it.
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
      if (range && (range[1] || range[2])) {
        file.stream.destroy();
        let start = range[1] ? Number(range[1]) : file.size - Number(range[2]);
        let end = range[1] && range[2] ? Number(range[2]) : file.size - 1;
        start = Math.max(0, start);
        end = Math.min(file.size - 1, end);
        if (start > end) return reply.status(416).header('Content-Range', `bytes */${file.size}`).send();
        const part = await deps.storage.open(key, { start, end });
        if (!part) throw notFound('File');
        return reply
          .status(206)
          .header('Content-Range', `bytes ${start}-${end}/${file.size}`)
          .header('Content-Length', end - start + 1)
          .send(part.stream);
      }
      return reply.header('Content-Length', file.size).send(file.stream);
    },
  );
};
