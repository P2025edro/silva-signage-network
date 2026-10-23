import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireSilva } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { hashPassword, passwordProblems } from '../lib/crypto.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { offsetOf, Pagination, toCsv, uuid } from '../lib/http.js';
import { regeneratePlaylists } from '../services/playlists.js';
import { presentScreen, SCREEN_SELECT } from '../services/screens.js';
import { getSettings, SETTING_RULES, type PlatformSettings } from '../services/settings.js';

const AnalyticsQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  companyId: uuid.optional(),
  campaignId: uuid.optional(),
  zoneId: uuid.optional(),
  screenId: uuid.optional(),
});

export const adminRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { deps } = app;

  async function screenHealthList() {
    const settings = await getSettings(deps.sql);
    const rows = await deps.sql`${SCREEN_SELECT(deps.sql)} WHERE sc.deleted_at IS NULL`;
    return rows.map((row) => presentScreen(row, deps.now(), settings['devices.offline_after_seconds']));
  }

  r.get('/api/admin/overview', { schema: { tags: ['admin'] } }, async (req) => {
    requireSilva(req, deps);
    const now = deps.now();
    const [counts] = await deps.sql`
      SELECT
        (SELECT count(*)::int FROM companies WHERE deleted_at IS NULL) AS companies,
        (SELECT count(*)::int FROM companies WHERE deleted_at IS NULL AND is_dev_fixture) AS "devFixtureCompanies",
        (SELECT count(*)::int FROM subscriptions WHERE status IN ('ACTIVE','TRIALING') AND current_period_end > ${now}) AS "activeSubscriptions",
        (SELECT count(*)::int FROM subscriptions WHERE status IN ('ACTIVE','TRIALING') AND current_period_end > ${now} AND source = 'STRIPE') AS "paidSubscriptions",
        (SELECT count(*)::int FROM campaigns WHERE deleted_at IS NULL AND status = 'ACTIVE') AS "activeCampaigns",
        (SELECT count(*)::int FROM campaigns WHERE deleted_at IS NULL AND status IN ('SUBMITTED','UNDER_REVIEW')) AS "pendingCampaigns",
        (SELECT count(*)::int FROM leads WHERE status = 'NEW') AS "newLeads",
        (SELECT count(*)::int FROM playback_events WHERE type = 'STARTED' AND occurred_at > ${new Date(now.getTime() - 86_400_000)}) AS "playbackStarts24h",
        (SELECT count(*)::int FROM playback_events WHERE type = 'FAILED' AND occurred_at > ${new Date(now.getTime() - 86_400_000)}) AS "playbackFailures24h",
        -- Verified revenue: only Stripe-confirmed subscriptions and paid invoices count.
        (SELECT COALESCE(sum(p.monthly_price_cents), 0)::int FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id
           WHERE s.source = 'STRIPE' AND s.status = 'ACTIVE' AND s.current_period_end > ${now}) AS "verifiedMrrCents",
        (SELECT COALESCE(sum(amount_cents), 0)::int FROM billing_events WHERE type = 'invoice.paid' AND processed_at IS NOT NULL
           AND received_at > ${new Date(now.getTime() - 30 * 86_400_000)}) AS "paidInvoices30dCents"`;
    const screens = await screenHealthList();
    const by = (h: string[]) => screens.filter((s) => h.includes(s.health)).length;
    const active = screens.filter((s) => s.status === 'ACTIVE').length;
    const online = by(['PLAYING', 'ONLINE', 'SYNC_PENDING', 'STALLED', 'ERROR']);
    const playbackByDay = await deps.sql`
      SELECT to_char(d, 'YYYY-MM-DD') AS day,
        (SELECT count(*)::int FROM playback_events pe WHERE pe.type = 'STARTED' AND (pe.occurred_at AT TIME ZONE 'Europe/Dublin')::date = d) AS starts,
        (SELECT count(*)::int FROM playback_events pe WHERE pe.type = 'FAILED' AND (pe.occurred_at AT TIME ZONE 'Europe/Dublin')::date = d) AS failures
      FROM generate_series((${now}::timestamptz AT TIME ZONE 'Europe/Dublin')::date - 13, (${now}::timestamptz AT TIME ZONE 'Europe/Dublin')::date, interval '1 day') d`;
    return {
      ...counts,
      screens: {
        total: screens.length,
        online,
        offline: by(['OFFLINE', 'NEVER_CONNECTED']),
        playing: by(['PLAYING']),
        errors: by(['ERROR', 'STALLED']),
        disabled: by(['DISABLED']),
      },
      networkHealthPct: active ? Math.round((online / active) * 100) : null,
      playbackByDay,
    };
  });

  r.get('/api/admin/alerts', { schema: { tags: ['admin'] } }, async (req) => {
    requireSilva(req, deps);
    const now = deps.now();
    const alerts: Array<{ severity: 'critical' | 'warning' | 'info'; kind: string; message: string; entityType: string; entityId: string; at: Date | null }> =
      [];
    for (const s of await screenHealthList()) {
      if (['OFFLINE', 'ERROR', 'STALLED'].includes(s.health)) {
        alerts.push({
          severity: s.health === 'OFFLINE' ? 'critical' : 'warning',
          kind: `screen.${s.health.toLowerCase()}`,
          message: `${s.displayName} at ${s.locationName} (${s.companyName}) is ${s.health.toLowerCase()}${s.lastError ? `: ${s.lastError}` : ''}`,
          entityType: 'screen',
          entityId: s.id as string,
          at: (s.lastHeartbeatAt as Date) ?? null,
        });
      } else if (s.health === 'NEVER_CONNECTED') {
        alerts.push({
          severity: 'info',
          kind: 'screen.never_connected',
          message: `${s.displayName} at ${s.locationName} has not connected since pairing`,
          entityType: 'screen',
          entityId: s.id as string,
          at: s.registeredAt as Date,
        });
      }
    }
    const waiting = await deps.sql`SELECT c.id, c.name, co.name AS company, c.submitted_at FROM campaigns c JOIN companies co ON co.id = c.company_id
      WHERE c.deleted_at IS NULL AND c.status IN ('SUBMITTED','UNDER_REVIEW') AND c.submitted_at < ${new Date(now.getTime() - 86_400_000)}`;
    for (const c of waiting)
      alerts.push({
        severity: 'warning',
        kind: 'campaign.review_overdue',
        message: `"${c.name}" from ${c.company} has waited over 24 hours for review`,
        entityType: 'campaign',
        entityId: c.id,
        at: c.submitted_at,
      });
    const billing = await deps.sql`SELECT id, type, company_id, received_at, processing_error FROM billing_events
      WHERE (type = 'invoice.payment_failed' OR processing_error IS NOT NULL) AND received_at > ${new Date(now.getTime() - 30 * 86_400_000)}`;
    for (const b of billing)
      alerts.push({
        severity: 'warning',
        kind: b.processing_error ? 'billing.processing_error' : 'billing.payment_failed',
        message: b.processing_error ? `Billing event could not be processed: ${b.processing_error}` : 'A subscription payment failed',
        entityType: 'billing_event',
        entityId: b.id,
        at: b.received_at,
      });
    const order = { critical: 0, warning: 1, info: 2 };
    return alerts.sort((a, b) => order[a.severity] - order[b.severity]);
  });

  r.get(
    '/api/admin/audit-logs',
    {
      schema: {
        tags: ['admin'],
        querystring: Pagination.extend({ companyId: uuid.optional(), action: z.string().max(80).optional(), entityId: uuid.optional() }),
      },
    },
    async (req) => {
      requireSilva(req, deps, { superAdminOnly: true });
      const q = req.query;
      const rows = await deps.sql`
        SELECT a.id::text, a.created_at AS "createdAt", a.actor_type AS "actorType", a.actor_id AS "actorId", u.email AS "actorEmail",
          a.company_id AS "companyId", c.name AS "companyName", a.action, a.entity_type AS "entityType", a.entity_id AS "entityId",
          a.metadata, host(a.ip) AS ip, count(*) OVER()::int AS total
        FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id AND a.actor_type = 'USER' LEFT JOIN companies c ON c.id = a.company_id
        WHERE true
          ${q.companyId ? deps.sql`AND a.company_id = ${q.companyId}` : deps.sql``}
          ${q.action ? deps.sql`AND a.action LIKE ${q.action.replace(/[%_]/g, '') + '%'}` : deps.sql``}
          ${q.entityId ? deps.sql`AND a.entity_id = ${q.entityId}` : deps.sql``}
        ORDER BY a.created_at DESC, a.id DESC LIMIT ${q.pageSize} OFFSET ${offsetOf(q)}`;
      return { items: rows, total: rows[0]?.total ?? 0, page: q.page, pageSize: q.pageSize };
    },
  );

  // ---- Settings ----------------------------------------------------------------
  r.get('/api/admin/settings', { schema: { tags: ['admin'] } }, async (req) => {
    requireSilva(req, deps);
    const values = await getSettings(deps.sql);
    const meta = await deps.sql`SELECT key, description, updated_at AS "updatedAt" FROM platform_settings`;
    return Object.entries(values).map(([key, value]) => ({
      key,
      value,
      rule: SETTING_RULES[key as keyof PlatformSettings],
      ...meta.find((m) => m.key === key),
    }));
  });

  r.put(
    '/api/admin/settings/:key',
    { schema: { tags: ['admin'], params: z.object({ key: z.string().max(80) }), body: z.object({ value: z.union([z.boolean(), z.number()]) }) } },
    async (req) => {
      const auth = requireSilva(req, deps, { superAdminOnly: true });
      const rule = SETTING_RULES[req.params.key as keyof PlatformSettings];
      if (!rule) throw notFound('Setting');
      const v = req.body.value;
      if (rule[0] === 'boolean' && typeof v !== 'boolean') throw badRequest('Expected true or false');
      if (rule[0] === 'number' && (typeof v !== 'number' || v < rule[1] || v > rule[2]))
        throw badRequest(`Expected a number between ${rule[1]} and ${rule[2]}`);
      await deps.sql.begin(async (tx) => {
        await tx`INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES (${req.params.key}, ${tx.json(v)}, ${auth.user.id}, now())
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
        await audit(tx, { actorType: 'USER', actorId: auth.user.id, action: 'settings.updated', metadata: { key: req.params.key, value: v }, ip: req.ip });
      });
      if (req.params.key.startsWith('distribution.')) await regeneratePlaylists(deps);
      return { ok: true };
    },
  );

  // ---- Zones -----------------------------------------------------------------
  r.get('/api/admin/zones', { schema: { tags: ['admin'] } }, async (req) => {
    requireSilva(req, deps);
    return deps.sql`SELECT z.id, z.slug, z.name, z.city, z.active,
      (SELECT count(*)::int FROM location_zones lz JOIN locations l ON l.id = lz.location_id AND l.deleted_at IS NULL WHERE lz.zone_id = z.id) AS locations,
      (SELECT count(*)::int FROM location_zones lz JOIN screens s ON s.location_id = lz.location_id AND s.deleted_at IS NULL WHERE lz.zone_id = z.id) AS screens
      FROM geographic_zones z ORDER BY z.city, z.name`;
  });

  const ZoneBody = z.object({
    name: z.string().trim().min(2).max(80),
    city: z.string().trim().min(2).max(80).default('Dublin'),
    active: z.boolean().default(true),
  });
  r.post('/api/admin/zones', { schema: { tags: ['admin'], body: ZoneBody } }, async (req, reply) => {
    const auth = requireSilva(req, deps, { superAdminOnly: true });
    const slug = `${req.body.name}`
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const [z1] = await deps.sql<
      { id: string }[]
    >`INSERT INTO geographic_zones (slug, name, city, active) VALUES (${slug}, ${req.body.name}, ${req.body.city}, ${req.body.active})
      ON CONFLICT (slug) DO NOTHING RETURNING id`;
    if (!z1) throw conflict('A zone with that name already exists');
    await audit(deps.sql, {
      actorType: 'USER',
      actorId: auth.user.id,
      action: 'zone.created',
      entityType: 'zone',
      entityId: z1.id,
      metadata: req.body,
      ip: req.ip,
    });
    reply.status(201);
    return { id: z1.id };
  });
  r.put('/api/admin/zones/:id', { schema: { tags: ['admin'], params: z.object({ id: uuid }), body: ZoneBody } }, async (req) => {
    const auth = requireSilva(req, deps, { superAdminOnly: true });
    const [z1] =
      await deps.sql`UPDATE geographic_zones SET name = ${req.body.name}, city = ${req.body.city}, active = ${req.body.active} WHERE id = ${req.params.id} RETURNING id`;
    if (!z1) throw notFound('Zone');
    await audit(deps.sql, {
      actorType: 'USER',
      actorId: auth.user.id,
      action: 'zone.updated',
      entityType: 'zone',
      entityId: req.params.id,
      metadata: req.body,
      ip: req.ip,
    });
    await regeneratePlaylists(deps);
    return { ok: true };
  });

  // ---- Analytics ---------------------------------------------------------------
  function analyticsFilter(q: z.infer<typeof AnalyticsQuery>) {
    const to = q.to ?? new Date(deps.now().getTime() + 60_000);
    const from = q.from ?? new Date(to.getTime() - 30 * 86_400_000);
    const where = deps.sql`pe.occurred_at >= ${from} AND pe.occurred_at < ${to}
      ${q.companyId ? deps.sql`AND pe.advertiser_company_id = ${q.companyId}` : deps.sql``}
      ${q.campaignId ? deps.sql`AND pe.campaign_id = ${q.campaignId}` : deps.sql``}
      ${q.screenId ? deps.sql`AND pe.screen_id = ${q.screenId}` : deps.sql``}
      ${q.zoneId ? deps.sql`AND EXISTS (SELECT 1 FROM screens s2 JOIN location_zones lz ON lz.location_id = s2.location_id WHERE s2.id = pe.screen_id AND lz.zone_id = ${q.zoneId})` : deps.sql``}`;
    return { from, to, where };
  }

  r.get('/api/admin/analytics', { schema: { tags: ['admin'], querystring: AnalyticsQuery } }, async (req) => {
    requireSilva(req, deps);
    const { from, to, where } = analyticsFilter(req.query);
    const agg = deps.sql`count(*) FILTER (WHERE pe.type = 'STARTED')::int AS starts, count(*) FILTER (WHERE pe.type = 'COMPLETED')::int AS completions, count(*) FILTER (WHERE pe.type = 'FAILED')::int AS failures`;
    const [byDay, byZone, byCategory, byCampaign] = await Promise.all([
      deps.sql`SELECT to_char(pe.occurred_at AT TIME ZONE 'Europe/Dublin', 'YYYY-MM-DD') AS day, ${agg} FROM playback_events pe WHERE ${where} GROUP BY 1 ORDER BY 1`,
      deps.sql`SELECT z.name AS zone, ${agg} FROM playback_events pe JOIN screens s ON s.id = pe.screen_id JOIN location_zones lz ON lz.location_id = s.location_id
        JOIN geographic_zones z ON z.id = lz.zone_id WHERE ${where} GROUP BY z.name ORDER BY starts DESC`,
      deps.sql`SELECT COALESCE(bc.name, 'Uncategorised') AS category, ${agg} FROM playback_events pe JOIN screens s ON s.id = pe.screen_id JOIN locations l ON l.id = s.location_id
        LEFT JOIN business_categories bc ON bc.id = l.category_id WHERE ${where} GROUP BY 1 ORDER BY starts DESC`,
      deps.sql`SELECT c.id, c.name AS campaign, co.name AS advertiser, ${agg} FROM playback_events pe JOIN campaigns c ON c.id = pe.campaign_id
        JOIN companies co ON co.id = c.company_id WHERE ${where} GROUP BY c.id, c.name, co.name ORDER BY starts DESC LIMIT 50`,
    ]);
    const [billing] = await deps.sql`
      SELECT
        (SELECT count(*)::int FROM subscriptions WHERE source = 'STRIPE' AND status = 'ACTIVE' AND current_period_end > ${deps.now()}) AS "activePaying",
        (SELECT count(*)::int FROM billing_events WHERE type = 'customer.subscription.deleted' AND received_at >= ${from} AND received_at < ${to}) AS cancellations,
        (SELECT count(*)::int FROM billing_events WHERE type = 'invoice.payment_failed' AND received_at >= ${from} AND received_at < ${to}) AS "failedPayments",
        (SELECT COALESCE(sum(amount_cents), 0)::int FROM billing_events WHERE type = 'invoice.paid' AND received_at >= ${from} AND received_at < ${to}) AS "paidCents"`;
    const revenueByPlan = await deps.sql`SELECT p.name AS plan, count(*)::int AS subscriptions, sum(p.monthly_price_cents)::int AS "mrrCents"
      FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id WHERE s.source = 'STRIPE' AND s.status = 'ACTIVE' AND s.current_period_end > ${deps.now()} GROUP BY p.name`;
    return { period: { from, to }, byDay, byZone, byCategory, byCampaign, billing: { ...billing, revenueByPlan } };
  });

  r.get('/api/admin/analytics/playback.csv', { schema: { tags: ['admin'], querystring: AnalyticsQuery } }, async (req, reply) => {
    requireSilva(req, deps);
    const { where } = analyticsFilter(req.query);
    const rows = await deps.sql`
      SELECT pe.occurred_at, pe.type, c.name AS campaign, adv.name AS advertiser, s.display_name AS screen, l.name AS location, host.name AS host, pe.playlist_version, pe.error
      FROM playback_events pe JOIN screens s ON s.id = pe.screen_id JOIN locations l ON l.id = s.location_id JOIN companies host ON host.id = s.company_id
      LEFT JOIN campaigns c ON c.id = pe.campaign_id LEFT JOIN companies adv ON adv.id = pe.advertiser_company_id
      WHERE ${where} ORDER BY pe.occurred_at LIMIT 100000`;
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="playback-events.csv"');
    return toCsv(
      ['occurred_at', 'type', 'campaign', 'advertiser', 'screen', 'location', 'host', 'playlist_version', 'error'],
      rows.map((x) => [x.occurred_at, x.type, x.campaign, x.advertiser, x.screen, x.location, x.host, x.playlist_version, x.error]),
    );
  });

  // ---- Silva staff ---------------------------------------------------------------
  r.get('/api/admin/users', { schema: { tags: ['admin'] } }, async (req) => {
    requireSilva(req, deps, { superAdminOnly: true });
    return deps.sql`SELECT id, email, full_name AS "fullName", platform_role AS "platformRole", totp_enabled AS "totpEnabled", last_login_at AS "lastLoginAt", status
      FROM users WHERE platform_role <> 'NONE' AND deleted_at IS NULL ORDER BY full_name`;
  });

  r.post(
    '/api/admin/users',
    {
      schema: {
        tags: ['admin'],
        body: z.object({
          email: z.string().trim().toLowerCase().email(),
          fullName: z.string().trim().min(2).max(120),
          password: z.string(),
          platformRole: z.enum(['SUPER_ADMIN', 'NETWORK_OPERATOR']),
        }),
      },
    },
    async (req, reply) => {
      const auth = requireSilva(req, deps, { superAdminOnly: true });
      const problems = passwordProblems(req.body.password);
      if (problems.length) throw badRequest(problems.join('. '));
      const hash = await hashPassword(req.body.password, deps.config.SCRYPT_LOG_N);
      const [u] = await deps.sql<{ id: string }[]>`
        INSERT INTO users (email, password_hash, full_name, platform_role)
        SELECT ${req.body.email}, ${hash}, ${req.body.fullName}, ${req.body.platformRole}
        WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = ${req.body.email} AND deleted_at IS NULL) RETURNING id`;
      if (!u) throw conflict('A user with that email already exists', 'EMAIL_TAKEN');
      await audit(deps.sql, {
        actorType: 'USER',
        actorId: auth.user.id,
        action: 'user.silva_created',
        entityType: 'user',
        entityId: u.id,
        metadata: { role: req.body.platformRole },
        ip: req.ip,
      });
      reply.status(201);
      return { id: u.id };
    },
  );
};
