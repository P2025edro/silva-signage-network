import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireCompany, requireSilva } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { CompanyParams, eircode, optionalText, uuid } from '../lib/http.js';
import { regeneratePlaylists } from '../services/playlists.js';

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'Use HH:MM');
const DayHours = z.array(z.object({ open: HHMM, close: HHMM })).max(4);
const OpeningHours = z.object({ mon: DayHours, tue: DayHours, wed: DayHours, thu: DayHours, fri: DayHours, sat: DayHours, sun: DayHours }).partial().nullable();

const LocationBody = z
  .object({
    name: z.string().trim().min(2).max(160),
    streetAddress: z.string().trim().min(3).max(300),
    eircode,
    city: z.string().trim().min(2).max(80).default('Dublin'),
    neighbourhood: optionalText(80),
    categoryId: uuid.nullish().transform((v) => v || null),
    openingHours: OpeningHours.default(null),
    participatesInNetwork: z.boolean().default(true),
    zoneIds: z.array(uuid).max(20).default([]),
    /** Only accepted together with coordinatesVerified = true (verified by Silva). */
    latitude: z.number().min(51).max(56).nullish(),
    longitude: z.number().min(-11).max(-5).nullish(),
    coordinatesVerified: z.boolean().default(false),
  })
  .refine((b) => (b.latitude == null && b.longitude == null) || b.coordinatesVerified, {
    message: 'Coordinates can only be saved once verified',
    path: ['coordinatesVerified'],
  });

const LocParams = CompanyParams.extend({ locationId: uuid });

export const locationRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { deps } = app;

  const selectLocations = (companyId: string | null, locationId?: string) => deps.sql`
    SELECT l.id, l.company_id AS "companyId", co.name AS "companyName", l.name, l.street_address AS "streetAddress", l.eircode, l.city,
      l.neighbourhood, l.latitude::float AS latitude, l.longitude::float AS longitude, l.coordinates_verified AS "coordinatesVerified",
      l.category_id AS "categoryId", bc.name AS "categoryName", l.timezone, l.opening_hours AS "openingHours",
      l.participates_in_network AS "participatesInNetwork", l.created_at AS "createdAt",
      ARRAY(SELECT zone_id FROM location_zones WHERE location_id = l.id) AS "zoneIds",
      ARRAY(SELECT z.name FROM location_zones lz JOIN geographic_zones z ON z.id = lz.zone_id WHERE lz.location_id = l.id ORDER BY z.name) AS "zoneNames",
      ARRAY(SELECT category_id FROM location_category_rules WHERE location_id = l.id AND kind = 'ALLOW') AS "allowCategoryIds",
      ARRAY(SELECT category_id FROM location_category_rules WHERE location_id = l.id AND kind = 'BLOCK') AS "blockCategoryIds",
      ARRAY(SELECT excluded_company_id FROM location_advertiser_exclusions WHERE location_id = l.id) AS "excludedCompanyIds",
      (SELECT count(*)::int FROM screens s WHERE s.location_id = l.id AND s.deleted_at IS NULL) AS "screenCount"
    FROM locations l JOIN companies co ON co.id = l.company_id LEFT JOIN business_categories bc ON bc.id = l.category_id
    WHERE l.deleted_at IS NULL
      ${companyId ? deps.sql`AND l.company_id = ${companyId}` : deps.sql``}
      ${locationId ? deps.sql`AND l.id = ${locationId}` : deps.sql``}
    ORDER BY co.name, l.name`;

  r.get('/api/admin/locations', { schema: { tags: ['admin'] } }, async (req) => {
    requireSilva(req, deps);
    return selectLocations(null);
  });

  r.get('/api/companies/:companyId/locations', { schema: { tags: ['locations'], params: CompanyParams } }, async (req) => {
    requireCompany(req, deps, req.params.companyId, 'VIEW');
    return selectLocations(req.params.companyId);
  });

  async function assertZones(zoneIds: string[]) {
    if (!zoneIds.length) return;
    const rows = await deps.sql`SELECT id FROM geographic_zones WHERE id = ANY(${zoneIds}::uuid[]) AND active`;
    if (rows.length !== new Set(zoneIds).size) throw badRequest('Unknown or inactive zone');
  }

  r.post('/api/companies/:companyId/locations', { schema: { tags: ['locations'], params: CompanyParams, body: LocationBody } }, async (req, reply) => {
    const actor = requireCompany(req, deps, req.params.companyId, 'OWNER');
    const b = req.body;
    // Only Silva can mark coordinates as verified.
    if (b.coordinatesVerified && actor.kind !== 'SILVA') throw badRequest('Only Silva Solutions can verify coordinates');
    await assertZones(b.zoneIds);
    const id = await deps.sql.begin(async (tx) => {
      const [l] = await tx<{ id: string }[]>`
        INSERT INTO locations (company_id, name, street_address, eircode, city, neighbourhood, category_id, opening_hours,
          participates_in_network, latitude, longitude, coordinates_verified)
        VALUES (${req.params.companyId}, ${b.name}, ${b.streetAddress}, ${b.eircode}, ${b.city}, ${b.neighbourhood}, ${b.categoryId},
          ${b.openingHours ? tx.json(b.openingHours as never) : null}, ${b.participatesInNetwork}, ${b.latitude ?? null}, ${b.longitude ?? null}, ${b.coordinatesVerified})
        RETURNING id`;
      for (const zoneId of new Set(b.zoneIds)) await tx`INSERT INTO location_zones (location_id, zone_id) VALUES (${l!.id}, ${zoneId})`;
      await audit(tx, {
        actorType: 'USER',
        actorId: req.auth!.user.id,
        companyId: req.params.companyId,
        action: 'location.created',
        entityType: 'location',
        entityId: l!.id,
        ip: req.ip,
      });
      return l!.id;
    });
    reply.status(201);
    return { id };
  });

  r.put('/api/companies/:companyId/locations/:locationId', { schema: { tags: ['locations'], params: LocParams, body: LocationBody } }, async (req) => {
    const actor = requireCompany(req, deps, req.params.companyId, 'OWNER');
    const b = req.body;
    if (b.coordinatesVerified && actor.kind !== 'SILVA') {
      const [cur] =
        await deps.sql`SELECT latitude::float AS lat, longitude::float AS lng, coordinates_verified FROM locations WHERE id = ${req.params.locationId}`;
      // Owners may resubmit already-verified coordinates unchanged, but not set new ones.
      if (!cur?.coordinates_verified || cur.lat !== b.latitude || cur.lng !== b.longitude) throw badRequest('Only Silva Solutions can verify coordinates');
    }
    await assertZones(b.zoneIds);
    await deps.sql.begin(async (tx) => {
      const [l] = await tx`
        UPDATE locations SET name = ${b.name}, street_address = ${b.streetAddress}, eircode = ${b.eircode}, city = ${b.city},
          neighbourhood = ${b.neighbourhood}, category_id = ${b.categoryId}, opening_hours = ${b.openingHours ? tx.json(b.openingHours as never) : null},
          participates_in_network = ${b.participatesInNetwork}, latitude = ${b.latitude ?? null}, longitude = ${b.longitude ?? null},
          coordinates_verified = ${b.coordinatesVerified}, updated_at = now()
        WHERE id = ${req.params.locationId} AND company_id = ${req.params.companyId} AND deleted_at IS NULL RETURNING id`;
      if (!l) throw notFound('Location');
      await tx`DELETE FROM location_zones WHERE location_id = ${req.params.locationId}`;
      for (const zoneId of new Set(b.zoneIds)) await tx`INSERT INTO location_zones (location_id, zone_id) VALUES (${req.params.locationId}, ${zoneId})`;
      await audit(tx, {
        actorType: 'USER',
        actorId: req.auth!.user.id,
        companyId: req.params.companyId,
        action: 'location.updated',
        entityType: 'location',
        entityId: req.params.locationId,
        ip: req.ip,
      });
    });
    await regeneratePlaylists(deps);
    return { ok: true };
  });

  r.put(
    '/api/companies/:companyId/locations/:locationId/rules',
    {
      schema: {
        tags: ['locations'],
        params: LocParams,
        body: z.object({
          allowCategoryIds: z.array(uuid).max(50).default([]),
          blockCategoryIds: z.array(uuid).max(50).default([]),
          excludedCompanyIds: z.array(uuid).max(200).default([]),
        }),
      },
    },
    async (req) => {
      requireCompany(req, deps, req.params.companyId, 'OWNER');
      const b = req.body;
      const overlap = b.allowCategoryIds.filter((c) => b.blockCategoryIds.includes(c));
      if (overlap.length) throw badRequest('A category cannot be both allowed and blocked');
      await deps.sql.begin(async (tx) => {
        const [l] = await tx`SELECT id FROM locations WHERE id = ${req.params.locationId} AND company_id = ${req.params.companyId} AND deleted_at IS NULL`;
        if (!l) throw notFound('Location');
        await tx`DELETE FROM location_category_rules WHERE location_id = ${req.params.locationId}`;
        await tx`DELETE FROM location_advertiser_exclusions WHERE location_id = ${req.params.locationId}`;
        for (const c of new Set(b.allowCategoryIds))
          await tx`INSERT INTO location_category_rules (location_id, category_id, kind) VALUES (${req.params.locationId}, ${c}, 'ALLOW')`;
        for (const c of new Set(b.blockCategoryIds))
          await tx`INSERT INTO location_category_rules (location_id, category_id, kind) VALUES (${req.params.locationId}, ${c}, 'BLOCK')`;
        for (const c of new Set(b.excludedCompanyIds))
          await tx`INSERT INTO location_advertiser_exclusions (location_id, excluded_company_id) VALUES (${req.params.locationId}, ${c})`;
        await audit(tx, {
          actorType: 'USER',
          actorId: req.auth!.user.id,
          companyId: req.params.companyId,
          action: 'location.rules_updated',
          entityType: 'location',
          entityId: req.params.locationId,
          metadata: b,
          ip: req.ip,
        });
      });
      await regeneratePlaylists(deps);
      return { ok: true };
    },
  );

  r.delete('/api/companies/:companyId/locations/:locationId', { schema: { tags: ['locations'], params: LocParams } }, async (req) => {
    requireCompany(req, deps, req.params.companyId, 'OWNER');
    await deps.sql.begin(async (tx) => {
      const [{ n }] = (await tx`SELECT count(*)::int AS n FROM screens WHERE location_id = ${req.params.locationId} AND deleted_at IS NULL`) as unknown as [
        { n: number },
      ];
      if (n > 0) throw conflict("Unpair this location's screens before removing it", 'LOCATION_HAS_SCREENS');
      const [l] =
        await tx`UPDATE locations SET deleted_at = now() WHERE id = ${req.params.locationId} AND company_id = ${req.params.companyId} AND deleted_at IS NULL RETURNING id`;
      if (!l) throw notFound('Location');
      await audit(tx, {
        actorType: 'USER',
        actorId: req.auth!.user.id,
        companyId: req.params.companyId,
        action: 'location.deleted',
        entityType: 'location',
        entityId: req.params.locationId,
        ip: req.ip,
      });
    });
    return { ok: true };
  });
};
