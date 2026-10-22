import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireCompany, requireSilva } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { hashPairingCode, normalisePairingCode } from '../lib/crypto.js';
import { badRequest, entitlement, notFound } from '../lib/errors.js';
import { CompanyParams, uuid } from '../lib/http.js';
import { companySubscriptionState } from '../services/entitlements.js';
import { regeneratePlaylists } from '../services/playlists.js';
import { COMMAND_TYPES, issueCommand, presentScreen, SCREEN_SELECT, unpairScreen } from '../services/screens.js';
import { getSettings } from '../services/settings.js';

const ScreenParams = CompanyParams.extend({ screenId: uuid });
const CommandBody = z.object({ type: z.enum(COMMAND_TYPES), idempotencyKey: z.string().max(100).optional() });

export const screenRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { deps } = app;

  async function listScreens(companyId: string | null, screenId?: string) {
    const settings = await getSettings(deps.sql);
    const rows = await deps.sql`${SCREEN_SELECT(deps.sql)}
      WHERE sc.deleted_at IS NULL
        ${companyId ? deps.sql`AND sc.company_id = ${companyId}` : deps.sql``}
        ${screenId ? deps.sql`AND sc.id = ${screenId}` : deps.sql``}
      ORDER BY co.name, l.name, sc.display_name`;
    const now = deps.now();
    return rows.map((row) => presentScreen(row, now, settings['devices.offline_after_seconds']));
  }

  r.get('/api/admin/screens', { schema: { tags: ['admin'] } }, async (req) => {
    requireSilva(req, deps);
    return listScreens(null);
  });

  r.get('/api/companies/:companyId/screens', { schema: { tags: ['screens'], params: CompanyParams } }, async (req) => {
    requireCompany(req, deps, req.params.companyId, 'VIEW');
    return listScreens(req.params.companyId);
  });

  r.get('/api/companies/:companyId/screens/:screenId', { schema: { tags: ['screens'], params: ScreenParams } }, async (req) => {
    requireCompany(req, deps, req.params.companyId, 'VIEW');
    const [screen] = await listScreens(req.params.companyId, req.params.screenId);
    if (!screen) throw notFound('Screen');
    const heartbeats = await deps.sql`SELECT received_at AS "receivedAt", playback_state AS "playbackState", playlist_version AS "playlistVersion", error
      FROM screen_heartbeats WHERE screen_id = ${req.params.screenId} ORDER BY received_at DESC LIMIT 20`;
    const commands = await deps.sql`SELECT id, type, status, created_at AS "createdAt", acknowledged_at AS "acknowledgedAt", result
      FROM screen_commands WHERE screen_id = ${req.params.screenId} ORDER BY created_at DESC LIMIT 20`;
    return { ...screen, heartbeats, commands };
  });

  r.post(
    '/api/companies/:companyId/screens/pair',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['screens'],
        params: CompanyParams,
        body: z.object({ code: z.string().trim().min(8).max(12), locationId: uuid, displayName: z.string().trim().min(2).max(80) }),
      },
    },
    async (req, reply) => {
      requireCompany(req, deps, req.params.companyId, 'OWNER');
      const { companyId } = req.params;
      const b = req.body;
      if (normalisePairingCode(b.code).length !== 8) throw badRequest('Pairing codes have 8 characters');
      const now = deps.now();

      const screenId: string | null = await deps.sql.begin(async (tx) => {
        const [loc] = await tx`SELECT id FROM locations WHERE id = ${b.locationId} AND company_id = ${companyId} AND deleted_at IS NULL`;
        if (!loc) throw notFound('Location');

        const sub = await companySubscriptionState(tx, companyId, now);
        if (!sub.active) throw entitlement('An active subscription is required to register screens');
        const [{ n }] = (await tx`SELECT count(*)::int AS n FROM screens WHERE company_id = ${companyId} AND deleted_at IS NULL`) as unknown as [{ n: number }];
        const max = sub.entitlements.max_screens ?? 0;
        if (n >= max) throw entitlement(`Your plan allows ${max} screen${max === 1 ? '' : 's'}`);

        const [session] = await tx<{ id: string; expires_at: Date }[]>`
          SELECT id, expires_at FROM device_pairing_sessions
          WHERE code_hash = ${hashPairingCode(deps.config.APP_SECRET, b.code)} AND status = 'PENDING' FOR UPDATE`;
        if (!session || session.expires_at <= now) {
          if (session) await tx`UPDATE device_pairing_sessions SET status = 'EXPIRED' WHERE id = ${session.id}`;
          return null;
        }
        const [screen] = await tx<{ id: string }[]>`
          INSERT INTO screens (company_id, location_id, display_name, registered_at) VALUES (${companyId}, ${b.locationId}, ${b.displayName}, ${now})
          RETURNING id`;
        await tx`UPDATE device_pairing_sessions SET status = 'CLAIMED', screen_id = ${screen!.id}, claimed_by_user_id = ${req.auth!.user.id}, claimed_at = ${now}
          WHERE id = ${session.id}`;
        await audit(tx, {
          actorType: 'USER',
          actorId: req.auth!.user.id,
          companyId,
          action: 'screen.paired',
          entityType: 'screen',
          entityId: screen!.id,
          metadata: { locationId: b.locationId, displayName: b.displayName },
          ip: req.ip,
        });
        return screen!.id;
      });
      if (!screenId) {
        await audit(deps.sql, { actorType: 'USER', actorId: req.auth!.user.id, companyId, action: 'screen.pairing_failed', ip: req.ip });
        throw badRequest('That code is invalid or has expired. Check the code on the TV.', { code: 'INVALID_PAIRING_CODE' });
      }
      await regeneratePlaylists(deps, [screenId]);
      reply.status(201);
      return { id: screenId };
    },
  );

  r.patch(
    '/api/companies/:companyId/screens/:screenId',
    { schema: { tags: ['screens'], params: ScreenParams, body: z.object({ displayName: z.string().trim().min(2).max(80) }) } },
    async (req) => {
      requireCompany(req, deps, req.params.companyId, 'OWNER');
      await deps.sql.begin(async (tx) => {
        const [s] = await tx`UPDATE screens SET display_name = ${req.body.displayName}, updated_at = now()
          WHERE id = ${req.params.screenId} AND company_id = ${req.params.companyId} AND deleted_at IS NULL RETURNING id`;
        if (!s) throw notFound('Screen');
        await audit(tx, {
          actorType: 'USER',
          actorId: req.auth!.user.id,
          companyId: req.params.companyId,
          action: 'screen.renamed',
          entityType: 'screen',
          entityId: req.params.screenId,
          metadata: req.body,
          ip: req.ip,
        });
      });
      return { ok: true };
    },
  );

  r.post('/api/companies/:companyId/screens/:screenId/unpair', { schema: { tags: ['screens'], params: ScreenParams } }, async (req) => {
    requireCompany(req, deps, req.params.companyId, 'OWNER');
    await deps.sql.begin((tx) => unpairScreen(tx, { ...req.params, userId: req.auth!.user.id, ip: req.ip, now: deps.now() }));
    return { ok: true };
  });

  r.post('/api/companies/:companyId/screens/:screenId/commands', { schema: { tags: ['screens'], params: ScreenParams, body: CommandBody } }, async (req) => {
    requireCompany(req, deps, req.params.companyId, 'OWNER');
    const [s] = await deps.sql`SELECT id FROM screens WHERE id = ${req.params.screenId} AND company_id = ${req.params.companyId} AND deleted_at IS NULL`;
    if (!s) throw notFound('Screen');
    return issueCommand(deps.sql, {
      ...req.params,
      type: req.body.type,
      idempotencyKey: req.body.idempotencyKey,
      userId: req.auth!.user.id,
      ip: req.ip,
      now: deps.now(),
    });
  });

  // ---- Silva operations ------------------------------------------------------
  r.post('/api/admin/screens/:screenId/commands', { schema: { tags: ['admin'], params: z.object({ screenId: uuid }), body: CommandBody } }, async (req) => {
    const auth = requireSilva(req, deps);
    const [s] = await deps.sql<{ company_id: string }[]>`SELECT company_id FROM screens WHERE id = ${req.params.screenId} AND deleted_at IS NULL`;
    if (!s) throw notFound('Screen');
    return issueCommand(deps.sql, {
      screenId: req.params.screenId,
      companyId: s.company_id,
      type: req.body.type,
      idempotencyKey: req.body.idempotencyKey,
      userId: auth.user.id,
      ip: req.ip,
      now: deps.now(),
    });
  });

  r.post(
    '/api/admin/screens/:screenId/status',
    { schema: { tags: ['admin'], params: z.object({ screenId: uuid }), body: z.object({ status: z.enum(['ACTIVE', 'DISABLED']) }) } },
    async (req) => {
      const auth = requireSilva(req, deps, { superAdminOnly: true });
      await deps.sql.begin(async (tx) => {
        const [s] = await tx<{ company_id: string }[]>`UPDATE screens SET status = ${req.body.status}, updated_at = now()
          WHERE id = ${req.params.screenId} AND deleted_at IS NULL RETURNING company_id`;
        if (!s) throw notFound('Screen');
        await audit(tx, {
          actorType: 'USER',
          actorId: auth.user.id,
          companyId: s.company_id,
          action: req.body.status === 'DISABLED' ? 'screen.disabled' : 'screen.enabled',
          entityType: 'screen',
          entityId: req.params.screenId,
          ip: req.ip,
        });
      });
      await regeneratePlaylists(deps, [req.params.screenId]);
      return { ok: true };
    },
  );

  r.post('/api/admin/screens/:screenId/unpair', { schema: { tags: ['admin'], params: z.object({ screenId: uuid }) } }, async (req) => {
    const auth = requireSilva(req, deps, { superAdminOnly: true });
    const [s] = await deps.sql<{ company_id: string }[]>`SELECT company_id FROM screens WHERE id = ${req.params.screenId} AND deleted_at IS NULL`;
    if (!s) throw notFound('Screen');
    await deps.sql.begin((tx) =>
      unpairScreen(tx, { screenId: req.params.screenId, companyId: s.company_id, userId: auth.user.id, ip: req.ip, now: deps.now() }),
    );
    return { ok: true };
  });
};
