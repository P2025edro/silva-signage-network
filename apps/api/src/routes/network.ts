import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireCompany, requireSilva } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { notFound } from '../lib/errors.js';
import { CompanyParams, uuid } from '../lib/http.js';
import { regeneratePlaylists } from '../services/playlists.js';

export const networkRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { deps } = app;

  /** Latest playlist for a screen, with the engine's reasoning for every candidate campaign. */
  async function playlistView(screenId: string, includeDecisions: boolean) {
    const [pl] = await deps.sql<
      {
        id: string;
        version: number;
        generated_at: Date;
        valid_until: Date;
        decisions: {
          screenReasons: string[];
          campaigns: Array<{ campaignId: string; eligible: boolean; reasons: string[]; slots: number; displacedByCapacity?: boolean }>;
        };
      }[]
    >`
      SELECT id, version, generated_at, valid_until, decisions FROM screen_playlists WHERE screen_id = ${screenId} ORDER BY version DESC LIMIT 1`;
    if (!pl) return { version: null, items: [], decisions: [], screenReasons: [] };
    const items = await deps.sql`
      SELECT pi.position, pi.duration_sec AS "durationSec", pi.not_after AS "notAfter", c.id AS "campaignId", c.name AS "campaignName",
        co.name AS "advertiserName", m.kind
      FROM playlist_items pi JOIN campaigns c ON c.id = pi.campaign_id JOIN companies co ON co.id = c.company_id JOIN media_assets m ON m.id = pi.media_asset_id
      WHERE pi.playlist_id = ${pl.id} ORDER BY pi.position`;
    let decisions: unknown[] = [];
    if (includeDecisions) {
      const ids = pl.decisions.campaigns.map((d) => d.campaignId);
      const names = new Map(
        (
          await deps.sql<{ id: string; name: string; advertiser: string }[]>`
          SELECT c.id, c.name, co.name AS advertiser FROM campaigns c JOIN companies co ON co.id = c.company_id WHERE c.id = ANY(${ids}::uuid[])`
        ).map((n) => [n.id, n]),
      );
      decisions = pl.decisions.campaigns.map((d) => ({
        ...d,
        campaignName: names.get(d.campaignId)?.name,
        advertiserName: names.get(d.campaignId)?.advertiser,
      }));
    }
    return { version: pl.version, generatedAt: pl.generated_at, validUntil: pl.valid_until, items, decisions, screenReasons: pl.decisions.screenReasons };
  }

  r.get('/api/admin/network/screens/:screenId/playlist', { schema: { tags: ['network'], params: z.object({ screenId: uuid }) } }, async (req) => {
    requireSilva(req, deps);
    const [s] = await deps.sql`SELECT id FROM screens WHERE id = ${req.params.screenId} AND deleted_at IS NULL`;
    if (!s) throw notFound('Screen');
    return playlistView(req.params.screenId, true);
  });

  // Hosts can see what plays on their own screens (advertiser names are public on the screen anyway),
  // but not the engine's reasoning about other advertisers' campaigns.
  r.get(
    '/api/companies/:companyId/screens/:screenId/playlist',
    { schema: { tags: ['screens'], params: CompanyParams.extend({ screenId: uuid }) } },
    async (req) => {
      requireCompany(req, deps, req.params.companyId, 'VIEW');
      const [s] = await deps.sql`SELECT id FROM screens WHERE id = ${req.params.screenId} AND company_id = ${req.params.companyId} AND deleted_at IS NULL`;
      if (!s) throw notFound('Screen');
      return playlistView(req.params.screenId, false);
    },
  );

  r.post('/api/admin/network/regenerate', { schema: { tags: ['network'] } }, async (req) => {
    const auth = requireSilva(req, deps);
    const results = await regeneratePlaylists(deps);
    await audit(deps.sql, {
      actorType: 'USER',
      actorId: auth.user.id,
      action: 'network.playlists_regenerated',
      metadata: { screens: results.length, changed: results.filter((r) => r.changed).length },
      ip: req.ip,
    });
    return { screens: results.length, changed: results.filter((r) => r.changed).length };
  });

  r.get('/api/admin/network/summary', { schema: { tags: ['network'] } }, async (req) => {
    requireSilva(req, deps);
    return deps.sql`
      SELECT s.id AS "screenId", s.display_name AS "screenName", l.name AS "locationName", co.name AS "hostName",
        p.version, p.valid_until AS "validUntil",
        (SELECT count(*)::int FROM playlist_items pi WHERE pi.playlist_id = p.id) AS "itemCount",
        (SELECT count(DISTINCT c.company_id)::int FROM playlist_items pi JOIN campaigns c ON c.id = pi.campaign_id WHERE pi.playlist_id = p.id) AS "advertiserCount",
        p.decisions -> 'screenReasons' AS "screenReasons"
      FROM screens s JOIN locations l ON l.id = s.location_id JOIN companies co ON co.id = s.company_id
      LEFT JOIN LATERAL (SELECT * FROM screen_playlists sp WHERE sp.screen_id = s.id ORDER BY version DESC LIMIT 1) p ON true
      WHERE s.deleted_at IS NULL ORDER BY co.name, s.display_name`;
  });
};
