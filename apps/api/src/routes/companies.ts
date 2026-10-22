import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireCompany, requireSilva, requireUser } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { hashPassword, passwordProblems } from '../lib/crypto.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { CompanyParams, eircode, offsetOf, optionalText, Pagination, uuid } from '../lib/http.js';
import { companySubscriptionState } from '../services/entitlements.js';
import { regeneratePlaylists } from '../services/playlists.js';

const CompanyProfile = z.object({
  name: z.string().trim().min(2).max(160),
  tradingName: optionalText(160),
  contactName: optionalText(120),
  email: z.string().trim().toLowerCase().email().max(254),
  phone: optionalText(40),
  address: optionalText(300),
  eircode,
  website: z
    .string()
    .trim()
    .url()
    .max(300)
    .nullish()
    .transform((v) => v || null),
  categoryId: uuid.nullish().transform((v) => v || null),
});

const NewUser = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  fullName: z.string().trim().min(2).max(120),
  /** Initial password set by whoever creates the account; the user should change it on first sign-in. */
  password: z.string(),
  role: z.enum(['OWNER', 'STAFF']),
});

export const companyRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { deps } = app;

  // ---- Reference data --------------------------------------------------------
  r.get('/api/categories', { schema: { tags: ['reference'] } }, async (req) => {
    requireUser(req);
    return deps.sql`SELECT id, slug, name FROM business_categories ORDER BY name`;
  });
  r.get('/api/zones', { schema: { tags: ['reference'] } }, async (req) => {
    requireUser(req);
    return deps.sql`SELECT id, slug, name, city, active FROM geographic_zones WHERE active ORDER BY name`;
  });

  // ---- Admin: companies -----------------------------------------------------
  r.get('/api/admin/companies', { schema: { tags: ['admin'], querystring: Pagination } }, async (req) => {
    requireSilva(req, deps);
    const q = req.query;
    const like = q.search ? `%${q.search}%` : null;
    const rows = await deps.sql`
      SELECT c.id, c.name, c.trading_name, c.email, c.status, c.is_dev_fixture, c.created_at, bc.name AS category,
        (SELECT count(*)::int FROM locations l WHERE l.company_id = c.id AND l.deleted_at IS NULL) AS locations,
        (SELECT count(*)::int FROM screens s WHERE s.company_id = c.id AND s.deleted_at IS NULL) AS screens,
        (SELECT s.status FROM subscriptions s WHERE s.company_id = c.id ORDER BY s.created_at DESC LIMIT 1) AS subscription_status,
        (SELECT p.name FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id WHERE s.company_id = c.id ORDER BY s.created_at DESC LIMIT 1) AS plan_name,
        count(*) OVER()::int AS total
      FROM companies c LEFT JOIN business_categories bc ON bc.id = c.category_id
      WHERE c.deleted_at IS NULL ${like ? deps.sql`AND (c.name ILIKE ${like} OR c.email ILIKE ${like} OR c.trading_name ILIKE ${like})` : deps.sql``}
      ORDER BY c.name LIMIT ${q.pageSize} OFFSET ${offsetOf(q)}`;
    return { items: rows, total: rows[0]?.total ?? 0, page: q.page, pageSize: q.pageSize };
  });

  r.post(
    '/api/admin/companies',
    {
      schema: {
        tags: ['admin'],
        body: CompanyProfile.extend({ isDevFixture: z.boolean().default(false), owner: NewUser.omit({ role: true }).optional() }),
      },
    },
    async (req, reply) => {
      const auth = requireSilva(req, deps, { superAdminOnly: true });
      const b = req.body;
      if (b.owner) {
        const problems = passwordProblems(b.owner.password);
        if (problems.length) throw badRequest(`Owner password: ${problems.join('. ')}`);
      }
      const ownerHash = b.owner ? await hashPassword(b.owner.password, deps.config.SCRYPT_LOG_N) : null;
      const company = await deps.sql.begin(async (tx) => {
        const [c] = await tx<{ id: string }[]>`
          INSERT INTO companies (name, trading_name, contact_name, email, phone, address, eircode, website, category_id, is_dev_fixture)
          VALUES (${b.name}, ${b.tradingName}, ${b.contactName}, ${b.email}, ${b.phone}, ${b.address}, ${b.eircode}, ${b.website}, ${b.categoryId}, ${b.isDevFixture})
          RETURNING id`;
        if (b.owner) {
          const [existing] = await tx`SELECT 1 FROM users WHERE email = ${b.owner.email} AND deleted_at IS NULL`;
          if (existing) throw conflict('A user with that email already exists', 'EMAIL_TAKEN');
          const [u] = await tx<{ id: string }[]>`
            INSERT INTO users (email, password_hash, full_name) VALUES (${b.owner.email}, ${ownerHash}, ${b.owner.fullName}) RETURNING id`;
          await tx`INSERT INTO user_company_memberships (user_id, company_id, role) VALUES (${u!.id}, ${c!.id}, 'OWNER')`;
        }
        await audit(tx, {
          actorType: 'USER',
          actorId: auth.user.id,
          companyId: c!.id,
          action: 'company.created',
          entityType: 'company',
          entityId: c!.id,
          metadata: { name: b.name, isDevFixture: b.isDevFixture },
          ip: req.ip,
        });
        return c!;
      });
      reply.status(201);
      return { id: company.id };
    },
  );

  r.post(
    '/api/admin/companies/:companyId/status',
    {
      schema: {
        tags: ['admin'],
        params: CompanyParams,
        body: z.object({ status: z.enum(['ACTIVE', 'SUSPENDED']), reason: z.string().trim().max(500).optional() }),
      },
    },
    async (req) => {
      const auth = requireSilva(req, deps, { superAdminOnly: true });
      const [c] = await deps.sql`UPDATE companies SET status = ${req.body.status}, updated_at = now()
        WHERE id = ${req.params.companyId} AND deleted_at IS NULL RETURNING id`;
      if (!c) throw notFound('Company');
      await audit(deps.sql, {
        actorType: 'USER',
        actorId: auth.user.id,
        companyId: req.params.companyId,
        action: `company.${req.body.status === 'SUSPENDED' ? 'suspended' : 'reactivated'}`,
        entityType: 'company',
        entityId: req.params.companyId,
        metadata: { reason: req.body.reason },
        ip: req.ip,
      });
      await regeneratePlaylists(deps);
      return { ok: true };
    },
  );

  // ---- Company (tenant-scoped) ----------------------------------------------
  r.get('/api/companies/:companyId', { schema: { tags: ['companies'], params: CompanyParams } }, async (req) => {
    requireCompany(req, deps, req.params.companyId, 'VIEW');
    const [c] = await deps.sql`
      SELECT c.id, c.name, c.trading_name AS "tradingName", c.contact_name AS "contactName", c.email, c.phone, c.address, c.eircode,
             c.website, c.category_id AS "categoryId", c.status, c.is_dev_fixture AS "isDevFixture", c.created_at AS "createdAt"
      FROM companies c WHERE c.id = ${req.params.companyId} AND c.deleted_at IS NULL`;
    if (!c) throw notFound('Company');
    const sub = await companySubscriptionState(deps.sql, req.params.companyId, deps.now());
    const [counts] = await deps.sql`
      SELECT (SELECT count(*)::int FROM locations WHERE company_id = ${req.params.companyId} AND deleted_at IS NULL) AS locations,
             (SELECT count(*)::int FROM screens WHERE company_id = ${req.params.companyId} AND deleted_at IS NULL) AS screens,
             (SELECT count(*)::int FROM campaigns WHERE company_id = ${req.params.companyId} AND deleted_at IS NULL AND status IN ('SCHEDULED','ACTIVE')) AS "liveCampaigns"`;
    return { ...c, subscription: sub, counts };
  });

  r.patch('/api/companies/:companyId', { schema: { tags: ['companies'], params: CompanyParams, body: CompanyProfile } }, async (req) => {
    requireCompany(req, deps, req.params.companyId, 'OWNER');
    const b = req.body;
    await deps.sql.begin(async (tx) => {
      await tx`UPDATE companies SET name = ${b.name}, trading_name = ${b.tradingName}, contact_name = ${b.contactName}, email = ${b.email},
        phone = ${b.phone}, address = ${b.address}, eircode = ${b.eircode}, website = ${b.website}, category_id = ${b.categoryId}, updated_at = now()
        WHERE id = ${req.params.companyId}`;
      await audit(tx, {
        actorType: 'USER',
        actorId: req.auth!.user.id,
        companyId: req.params.companyId,
        action: 'company.updated',
        entityType: 'company',
        entityId: req.params.companyId,
        ip: req.ip,
      });
    });
    return { ok: true };
  });

  r.get('/api/companies/:companyId/users', { schema: { tags: ['companies'], params: CompanyParams } }, async (req) => {
    requireCompany(req, deps, req.params.companyId, 'VIEW');
    return deps.sql`
      SELECT u.id, u.email, u.full_name AS "fullName", m.role, u.last_login_at AS "lastLoginAt", u.status
      FROM user_company_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.company_id = ${req.params.companyId} AND u.deleted_at IS NULL ORDER BY m.role, u.full_name`;
  });

  r.post('/api/companies/:companyId/users', { schema: { tags: ['companies'], params: CompanyParams, body: NewUser } }, async (req, reply) => {
    requireCompany(req, deps, req.params.companyId, 'OWNER');
    const b = req.body;
    const problems = passwordProblems(b.password);
    if (problems.length) throw badRequest(problems.join('. '));
    const hash = await hashPassword(b.password, deps.config.SCRYPT_LOG_N);
    const id = await deps.sql.begin(async (tx) => {
      const [existing] = await tx`SELECT 1 FROM users WHERE email = ${b.email} AND deleted_at IS NULL`;
      // Users belong to one company in the MVP; this avoids silently linking an existing account.
      if (existing) throw conflict('A user with that email already exists', 'EMAIL_TAKEN');
      const [u] = await tx<{ id: string }[]>`INSERT INTO users (email, password_hash, full_name) VALUES (${b.email}, ${hash}, ${b.fullName}) RETURNING id`;
      await tx`INSERT INTO user_company_memberships (user_id, company_id, role) VALUES (${u!.id}, ${req.params.companyId}, ${b.role})`;
      await audit(tx, {
        actorType: 'USER',
        actorId: req.auth!.user.id,
        companyId: req.params.companyId,
        action: 'company.user_added',
        entityType: 'user',
        entityId: u!.id,
        metadata: { role: b.role },
        ip: req.ip,
      });
      return u!.id;
    });
    reply.status(201);
    return { id };
  });

  r.delete('/api/companies/:companyId/users/:userId', { schema: { tags: ['companies'], params: CompanyParams.extend({ userId: uuid }) } }, async (req) => {
    requireCompany(req, deps, req.params.companyId, 'OWNER');
    if (req.params.userId === req.auth!.user.id) throw badRequest('You cannot remove yourself');
    await deps.sql.begin(async (tx) => {
      const [m] = await tx`DELETE FROM user_company_memberships WHERE company_id = ${req.params.companyId} AND user_id = ${req.params.userId} RETURNING role`;
      if (!m) throw notFound('User');
      const [{ owners }] =
        (await tx`SELECT count(*)::int AS owners FROM user_company_memberships WHERE company_id = ${req.params.companyId} AND role = 'OWNER'`) as unknown as [
          { owners: number },
        ];
      if (owners === 0) throw badRequest('A company must keep at least one owner');
      await tx`UPDATE sessions SET revoked_at = now() WHERE user_id = ${req.params.userId} AND revoked_at IS NULL`;
      await audit(tx, {
        actorType: 'USER',
        actorId: req.auth!.user.id,
        companyId: req.params.companyId,
        action: 'company.user_removed',
        entityType: 'user',
        entityId: req.params.userId,
        ip: req.ip,
      });
    });
    return { ok: true };
  });

  r.get('/api/companies/:companyId/notifications', { schema: { tags: ['companies'], params: CompanyParams } }, async (req) => {
    requireCompany(req, deps, req.params.companyId, 'VIEW');
    return deps.sql`SELECT id, type, message, entity_type AS "entityType", entity_id AS "entityId", read_at AS "readAt", created_at AS "createdAt"
      FROM notifications WHERE company_id = ${req.params.companyId} ORDER BY created_at DESC LIMIT 50`;
  });
};
