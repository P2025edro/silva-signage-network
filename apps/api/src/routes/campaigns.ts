import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  COUNTS_AGAINST_QUOTA,
  isEditable,
  nextCampaignStatus,
  validateSchedule,
  type ActorKind,
  type CampaignAction,
  type CampaignStatus,
} from '@silva/shared';
import { z } from 'zod';
import { isSilva, requireCompany, requireSilva, requireUser } from '../auth/session.js';
import type { Db } from '../db.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, entitlement, notFound } from '../lib/errors.js';
import { CompanyParams, offsetOf, optionalText, Pagination, toCsv, uuid } from '../lib/http.js';
import { campaignCapacity, loadCampaignDetail } from '../services/campaigns.js';
import { companySubscriptionState } from '../services/entitlements.js';
import { regeneratePlaylists } from '../services/playlists.js';

const Schedule = z.object({
  days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
  startMinute: z.number().int().min(0).max(1440),
  endMinute: z.number().int().min(0).max(1440),
});

const CampaignBody = z
  .object({
    name: z.string().trim().min(2).max(120),
    description: optionalText(1000),
    startAt: z.coerce.date(),
    endAt: z.coerce.date(),
    requestedPlaysPerDay: z
      .number()
      .int()
      .min(1)
      .max(100_000)
      .nullish()
      .transform((v) => v ?? null),
    schedule: Schedule.nullish().transform((v) => v ?? null),
    targetZoneIds: z.array(uuid).max(50).default([]),
    targetCategoryIds: z.array(uuid).max(50).default([]),
    excludedCategoryIds: z.array(uuid).max(50).default([]),
    media: z
      .array(z.object({ mediaAssetId: uuid, displaySeconds: z.number().int().min(5).max(60).default(15) }))
      .max(10)
      .default([]),
  })
  .superRefine((b, ctx) => {
    if (b.endAt <= b.startAt) ctx.addIssue({ code: 'custom', path: ['endAt'], message: 'End must be after start' });
    if (b.schedule) for (const m of validateSchedule(b.schedule)) ctx.addIssue({ code: 'custom', path: ['schedule'], message: m });
    if (new Set(b.media.map((m) => m.mediaAssetId)).size !== b.media.length)
      ctx.addIssue({ code: 'custom', path: ['media'], message: 'Media must not repeat' });
  });
type CampaignInput = z.infer<typeof CampaignBody>;

const CampaignParams = CompanyParams.extend({ campaignId: uuid });
const ACTIONS = ['SUBMIT', 'START_REVIEW', 'APPROVE', 'REJECT', 'REQUEST_CHANGES', 'PAUSE', 'RESUME', 'CANCEL'] as const;
/** Actions that change what may play right now. */
const AFFECTS_PLAYBACK = new Set<CampaignAction>(['APPROVE', 'PAUSE', 'RESUME', 'CANCEL']);

async function writeCampaignChildren(tx: Db, campaignId: string, companyId: string, b: CampaignInput) {
  if (b.media.length) {
    const owned = await tx`SELECT id FROM media_assets WHERE id = ANY(${b.media.map((m) => m.mediaAssetId)}::uuid[])
      AND company_id = ${companyId} AND deleted_at IS NULL`;
    if (owned.length !== b.media.length) throw badRequest('Some media does not exist or belongs to another account');
  }
  await tx`DELETE FROM campaign_media WHERE campaign_id = ${campaignId}`;
  await tx`DELETE FROM campaign_targeting WHERE campaign_id = ${campaignId}`;
  await tx`DELETE FROM campaign_target_categories WHERE campaign_id = ${campaignId}`;
  await tx`DELETE FROM campaign_exclusions WHERE campaign_id = ${campaignId}`;
  for (const [position, m] of b.media.entries()) {
    await tx`INSERT INTO campaign_media (campaign_id, media_asset_id, position, display_seconds) VALUES (${campaignId}, ${m.mediaAssetId}, ${position}, ${m.displaySeconds})`;
  }
  for (const z of new Set(b.targetZoneIds)) await tx`INSERT INTO campaign_targeting (campaign_id, zone_id) VALUES (${campaignId}, ${z})`;
  for (const c of new Set(b.targetCategoryIds)) await tx`INSERT INTO campaign_target_categories (campaign_id, category_id) VALUES (${campaignId}, ${c})`;
  for (const c of new Set(b.excludedCategoryIds)) await tx`INSERT INTO campaign_exclusions (campaign_id, category_id) VALUES (${campaignId}, ${c})`;
}

export const campaignRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { deps } = app;

  const listQuery = (companyId: string | null, status: string | undefined, q: z.infer<typeof Pagination>) => deps.sql`
    SELECT c.id, c.company_id AS "companyId", co.name AS "companyName", co.is_dev_fixture AS "isDevFixture", c.name, c.status,
      c.start_at AS "startAt", c.end_at AS "endAt", c.priority, c.submitted_at AS "submittedAt", c.updated_at AS "updatedAt",
      (SELECT count(*)::int FROM campaign_media WHERE campaign_id = c.id) AS "mediaCount",
      (SELECT count(*)::int FROM playback_events pe WHERE pe.campaign_id = c.id AND pe.type = 'STARTED') AS "playbackStarts",
      count(*) OVER()::int AS total
    FROM campaigns c JOIN companies co ON co.id = c.company_id
    WHERE c.deleted_at IS NULL
      ${companyId ? deps.sql`AND c.company_id = ${companyId}` : deps.sql``}
      ${status ? deps.sql`AND c.status = ANY(${status.split(',')}::campaign_status[])` : deps.sql``}
      ${q.search ? deps.sql`AND (c.name ILIKE ${'%' + q.search + '%'} OR co.name ILIKE ${'%' + q.search + '%'})` : deps.sql``}
    ORDER BY CASE WHEN c.status IN ('SUBMITTED', 'UNDER_REVIEW') THEN 0 ELSE 1 END, c.submitted_at NULLS LAST, c.updated_at DESC
    LIMIT ${q.pageSize} OFFSET ${offsetOf(q)}`;

  const StatusFilter = z
    .string()
    .regex(/^[A-Z_]+(,[A-Z_]+)*$/)
    .optional();

  r.get(
    '/api/companies/:companyId/campaigns',
    { schema: { tags: ['campaigns'], params: CompanyParams, querystring: Pagination.extend({ status: StatusFilter }) } },
    async (req) => {
      requireCompany(req, deps, req.params.companyId, 'VIEW');
      const rows = await listQuery(req.params.companyId, req.query.status, req.query);
      return { items: rows, total: rows[0]?.total ?? 0, page: req.query.page, pageSize: req.query.pageSize };
    },
  );

  r.get('/api/admin/campaigns', { schema: { tags: ['admin'], querystring: Pagination.extend({ status: StatusFilter }) } }, async (req) => {
    requireSilva(req, deps);
    const rows = await listQuery(null, req.query.status, req.query);
    return { items: rows, total: rows[0]?.total ?? 0, page: req.query.page, pageSize: req.query.pageSize };
  });

  r.post('/api/companies/:companyId/campaigns', { schema: { tags: ['campaigns'], params: CompanyParams, body: CampaignBody } }, async (req, reply) => {
    requireCompany(req, deps, req.params.companyId, 'EDIT');
    const b = req.body;
    const id = await deps.sql.begin(async (tx) => {
      const [c] = await tx<{ id: string }[]>`
        INSERT INTO campaigns (company_id, name, description, start_at, end_at, requested_plays_per_day, schedule, created_by)
        VALUES (${req.params.companyId}, ${b.name}, ${b.description}, ${b.startAt}, ${b.endAt}, ${b.requestedPlaysPerDay},
                ${b.schedule ? tx.json(b.schedule as never) : null}, ${req.auth!.user.id})
        RETURNING id`;
      await writeCampaignChildren(tx, c!.id, req.params.companyId, b);
      await audit(tx, {
        actorType: 'USER',
        actorId: req.auth!.user.id,
        companyId: req.params.companyId,
        action: 'campaign.created',
        entityType: 'campaign',
        entityId: c!.id,
        ip: req.ip,
      });
      return c!.id;
    });
    reply.status(201);
    return { id };
  });

  r.get('/api/companies/:companyId/campaigns/:campaignId', { schema: { tags: ['campaigns'], params: CampaignParams } }, async (req) => {
    requireCompany(req, deps, req.params.companyId, 'VIEW');
    return loadCampaignDetail(deps, req.params.campaignId, req.params.companyId);
  });

  r.get('/api/admin/campaigns/:campaignId', { schema: { tags: ['admin'], params: z.object({ campaignId: uuid }) } }, async (req) => {
    requireSilva(req, deps);
    const detail = await loadCampaignDetail(deps, req.params.campaignId, null);
    const capacity = await campaignCapacity(deps.sql, req.params.campaignId, detail.requestedPlaysPerDay, deps.now());
    return { ...detail, capacity };
  });

  r.put('/api/companies/:companyId/campaigns/:campaignId', { schema: { tags: ['campaigns'], params: CampaignParams, body: CampaignBody } }, async (req) => {
    requireCompany(req, deps, req.params.companyId, 'EDIT');
    const b = req.body;
    await deps.sql.begin(async (tx) => {
      const [c] = await tx<{ status: CampaignStatus }[]>`SELECT status FROM campaigns WHERE id = ${req.params.campaignId}
        AND company_id = ${req.params.companyId} AND deleted_at IS NULL FOR UPDATE`;
      if (!c) throw notFound('Campaign');
      if (!isEditable(c.status)) throw conflict('Only draft campaigns or campaigns returned for changes can be edited', 'NOT_EDITABLE');
      await tx`UPDATE campaigns SET name = ${b.name}, description = ${b.description}, start_at = ${b.startAt}, end_at = ${b.endAt},
        requested_plays_per_day = ${b.requestedPlaysPerDay}, schedule = ${b.schedule ? tx.json(b.schedule as never) : null}, updated_at = now()
        WHERE id = ${req.params.campaignId}`;
      await writeCampaignChildren(tx, req.params.campaignId, req.params.companyId, b);
      await audit(tx, {
        actorType: 'USER',
        actorId: req.auth!.user.id,
        companyId: req.params.companyId,
        action: 'campaign.updated',
        entityType: 'campaign',
        entityId: req.params.campaignId,
        ip: req.ip,
      });
    });
    return { ok: true };
  });

  r.post(
    '/api/companies/:companyId/campaigns/:campaignId/actions',
    { schema: { tags: ['campaigns'], params: CampaignParams, body: z.object({ action: z.enum(ACTIONS), reason: z.string().trim().max(1000).optional() }) } },
    async (req) => {
      const auth = requireUser(req);
      let actor: ActorKind;
      if (isSilva(auth)) {
        requireSilva(req, deps);
        actor = 'SILVA';
      } else {
        const a = requireCompany(req, deps, req.params.companyId, 'VIEW');
        actor = a.kind === 'OWNER' ? 'OWNER' : 'STAFF';
      }
      const { action, reason } = req.body;
      const now = deps.now();

      const result = await deps.sql.begin(async (tx) => {
        const [c] = await tx<{ id: string; status: CampaignStatus; start_at: Date; end_at: Date; name: string }[]>`
          SELECT id, status, start_at, end_at, name FROM campaigns
          WHERE id = ${req.params.campaignId} AND company_id = ${req.params.companyId} AND deleted_at IS NULL FOR UPDATE`;
        if (!c) throw notFound('Campaign');
        const next = nextCampaignStatus({ action, actor, current: c.status, startAt: c.start_at, endAt: c.end_at, now, reason });

        if (action === 'SUBMIT') await assertSubmittable(tx, req.params.companyId, req.params.campaignId, c, now);

        await tx`UPDATE campaigns SET status = ${next}, updated_at = ${now},
          submitted_at = ${action === 'SUBMIT' ? now : tx`submitted_at`},
          reviewed_by = ${actor === 'SILVA' ? auth.user.id : tx`reviewed_by`},
          reviewed_at = ${actor === 'SILVA' ? now : tx`reviewed_at`},
          review_note = ${['REJECT', 'REQUEST_CHANGES'].includes(action) ? (reason ?? null) : tx`review_note`}
          WHERE id = ${c.id}`;
        await tx`INSERT INTO campaign_reviews (campaign_id, reviewer_id, decision, from_status, to_status, reason)
          VALUES (${c.id}, ${auth.user.id}, ${action}, ${c.status}, ${next}, ${reason ?? null})`;
        if (actor === 'SILVA') {
          const verb: Record<string, string> = {
            APPROVE: 'approved',
            REJECT: 'rejected',
            REQUEST_CHANGES: 'returned for changes',
            PAUSE: 'paused by Silva Solutions',
            RESUME: 'resumed',
            CANCEL: 'cancelled by Silva Solutions',
            START_REVIEW: 'under review',
          };
          await tx`INSERT INTO notifications (company_id, type, message, entity_type, entity_id)
            VALUES (${req.params.companyId}, ${'campaign.' + action.toLowerCase()}, ${`Campaign "${c.name}" ${verb[action] ?? action.toLowerCase()}${reason ? `: ${reason}` : ''}`}, 'campaign', ${c.id})`;
        }
        await audit(tx, {
          actorType: 'USER',
          actorId: auth.user.id,
          companyId: req.params.companyId,
          action: `campaign.${action.toLowerCase()}`,
          entityType: 'campaign',
          entityId: c.id,
          metadata: { from: c.status, to: next, reason },
          ip: req.ip,
        });
        return { status: next };
      });
      if (AFFECTS_PLAYBACK.has(action)) await regeneratePlaylists(deps);
      return result;
    },
  );

  async function assertSubmittable(tx: Db, companyId: string, campaignId: string, c: { start_at: Date; end_at: Date }, now: Date) {
    const sub = await companySubscriptionState(tx, companyId, now);
    if (!sub.active) throw entitlement('An active subscription is required to submit campaigns');
    const e = sub.entitlements;
    const [{ n }] = (await tx`SELECT count(*)::int AS n FROM campaigns WHERE company_id = ${companyId} AND id <> ${campaignId}
      AND deleted_at IS NULL AND status = ANY(${COUNTS_AGAINST_QUOTA}::campaign_status[])`) as unknown as [{ n: number }];
    if (n >= (e.max_active_campaigns ?? 0)) throw entitlement(`Your plan allows ${e.max_active_campaigns ?? 0} active campaign(s)`);
    const days = Math.ceil((c.end_at.getTime() - c.start_at.getTime()) / 86_400_000);
    if (days > (e.max_campaign_days ?? 0)) throw entitlement(`Your plan allows campaigns of up to ${e.max_campaign_days ?? 0} days`);
    const [{ zones }] = (await tx`SELECT count(*)::int AS zones FROM campaign_targeting WHERE campaign_id = ${campaignId}`) as unknown as [{ zones: number }];
    if (zones > (e.max_target_zones ?? 0)) throw entitlement(`Your plan allows targeting up to ${e.max_target_zones ?? 0} zones`);
    const [{ ready }] = (await tx`SELECT count(*)::int AS ready FROM campaign_media cm JOIN media_assets m ON m.id = cm.media_asset_id
      WHERE cm.campaign_id = ${campaignId} AND m.status = 'READY' AND m.deleted_at IS NULL`) as unknown as [{ ready: number }];
    if (ready === 0) throw badRequest('Add at least one image or video before submitting');
  }

  r.post(
    '/api/admin/campaigns/:campaignId/priority',
    { schema: { tags: ['admin'], params: z.object({ campaignId: uuid }), body: z.object({ priority: z.number().int().min(1).max(5) }) } },
    async (req) => {
      const auth = requireSilva(req, deps);
      const [c] = await deps.sql<{ company_id: string }[]>`UPDATE campaigns SET priority = ${req.body.priority}, updated_at = now()
        WHERE id = ${req.params.campaignId} AND deleted_at IS NULL RETURNING company_id`;
      if (!c) throw notFound('Campaign');
      await audit(deps.sql, {
        actorType: 'USER',
        actorId: auth.user.id,
        companyId: c.company_id,
        action: 'campaign.priority_changed',
        entityType: 'campaign',
        entityId: req.params.campaignId,
        metadata: req.body,
        ip: req.ip,
      });
      await regeneratePlaylists(deps);
      return { ok: true };
    },
  );

  r.delete('/api/companies/:companyId/campaigns/:campaignId', { schema: { tags: ['campaigns'], params: CampaignParams } }, async (req) => {
    requireCompany(req, deps, req.params.companyId, 'EDIT');
    await deps.sql.begin(async (tx) => {
      const [c] = await tx<
        { status: CampaignStatus }[]
      >`SELECT status FROM campaigns WHERE id = ${req.params.campaignId} AND company_id = ${req.params.companyId} AND deleted_at IS NULL`;
      if (!c) throw notFound('Campaign');
      if (c.status !== 'DRAFT') throw conflict('Only drafts can be deleted. Cancel the campaign instead.', 'NOT_DRAFT');
      await tx`UPDATE campaigns SET deleted_at = now() WHERE id = ${req.params.campaignId}`;
      await audit(tx, {
        actorType: 'USER',
        actorId: req.auth!.user.id,
        companyId: req.params.companyId,
        action: 'campaign.deleted',
        entityType: 'campaign',
        entityId: req.params.campaignId,
        ip: req.ip,
      });
    });
    return { ok: true };
  });

  // ---- Reports ---------------------------------------------------------------
  const ReportQuery = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() });

  async function report(companyId: string, campaignId: string, from: Date, to: Date) {
    const detail = await loadCampaignDetail(deps, campaignId, companyId);
    const totals = await deps.sql`SELECT type, count(*)::int AS n FROM playback_events
      WHERE campaign_id = ${campaignId} AND occurred_at >= ${from} AND occurred_at < ${to} GROUP BY type`;
    const byLocation = await deps.sql`
      SELECT l.name AS location, co.name AS host, s.display_name AS screen,
        count(*) FILTER (WHERE pe.type = 'STARTED')::int AS starts,
        count(*) FILTER (WHERE pe.type = 'COMPLETED')::int AS completions,
        count(*) FILTER (WHERE pe.type = 'FAILED')::int AS failures
      FROM playback_events pe JOIN screens s ON s.id = pe.screen_id JOIN locations l ON l.id = s.location_id JOIN companies co ON co.id = s.company_id
      WHERE pe.campaign_id = ${campaignId} AND pe.occurred_at >= ${from} AND pe.occurred_at < ${to}
      GROUP BY l.name, co.name, s.display_name ORDER BY starts DESC`;
    const byZone = await deps.sql`
      SELECT z.name AS zone, count(*) FILTER (WHERE pe.type = 'STARTED')::int AS starts, count(*) FILTER (WHERE pe.type = 'COMPLETED')::int AS completions
      FROM playback_events pe JOIN screens s ON s.id = pe.screen_id JOIN location_zones lz ON lz.location_id = s.location_id JOIN geographic_zones z ON z.id = lz.zone_id
      WHERE pe.campaign_id = ${campaignId} AND pe.occurred_at >= ${from} AND pe.occurred_at < ${to}
      GROUP BY z.name ORDER BY starts DESC`;
    const byDay = await deps.sql`
      SELECT to_char(pe.occurred_at AT TIME ZONE 'Europe/Dublin', 'YYYY-MM-DD') AS day,
        count(*) FILTER (WHERE pe.type = 'STARTED')::int AS starts, count(*) FILTER (WHERE pe.type = 'COMPLETED')::int AS completions,
        count(*) FILTER (WHERE pe.type = 'FAILED')::int AS failures
      FROM playback_events pe WHERE pe.campaign_id = ${campaignId} AND pe.occurred_at >= ${from} AND pe.occurred_at < ${to}
      GROUP BY 1 ORDER BY 1`;
    const sub = await companySubscriptionState(deps.sql, companyId, deps.now());
    const capacity = await campaignCapacity(deps.sql, campaignId, detail.requestedPlaysPerDay, deps.now());
    const t = Object.fromEntries(totals.map((x) => [x.type, x.n]));
    return {
      campaign: { id: detail.id, name: detail.name, status: detail.status, startAt: detail.startAt, endAt: detail.endAt },
      period: { from, to },
      totals: { scheduled: t.SCHEDULED ?? 0, started: t.STARTED ?? 0, completed: t.COMPLETED ?? 0, failed: t.FAILED ?? 0 },
      byLocation,
      byZone,
      byDay,
      quota: {
        allocation: sub.entitlements.monthly_playback_allocation ?? 0,
        usedThisPeriod: sub.playsThisPeriod,
        periodEnd: sub.subscription?.currentPeriodEnd ?? null,
      },
      capacity,
      note: 'Counts are playback events reported by screens. A completed playback does not prove that a person saw the advert.',
    };
  }

  r.get(
    '/api/companies/:companyId/campaigns/:campaignId/report',
    { schema: { tags: ['campaigns'], params: CampaignParams, querystring: ReportQuery } },
    async (req) => {
      requireCompany(req, deps, req.params.companyId, 'VIEW');
      const to = req.query.to ?? new Date(deps.now().getTime() + 60_000);
      const from = req.query.from ?? new Date(to.getTime() - 30 * 86_400_000);
      return report(req.params.companyId, req.params.campaignId, from, to);
    },
  );

  r.get(
    '/api/companies/:companyId/campaigns/:campaignId/report.csv',
    { schema: { tags: ['campaigns'], params: CampaignParams, querystring: ReportQuery } },
    async (req, reply) => {
      requireCompany(req, deps, req.params.companyId, 'VIEW');
      const to = req.query.to ?? new Date(deps.now().getTime() + 60_000);
      const from = req.query.from ?? new Date(to.getTime() - 30 * 86_400_000);
      const rep = await report(req.params.companyId, req.params.campaignId, from, to);
      reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="campaign-${req.params.campaignId}.csv"`);
      return toCsv(
        ['day', 'starts', 'completions', 'failures'],
        rep.byDay.map((d) => [d.day, d.starts, d.completions, d.failures]),
      );
    },
  );
};
