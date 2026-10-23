import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireSilva } from '../auth/session.js';
import { audit } from '../lib/audit.js';
import { notFound } from '../lib/errors.js';
import { optionalText, uuid } from '../lib/http.js';

const LeadBody = z.object({
  businessName: z.string().trim().min(2).max(160),
  contactName: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  phone: optionalText(40),
  area: optionalText(80),
  businessType: optionalText(80),
  screensEstimate: z.number().int().min(0).max(100).nullish(),
  interestedPlan: z.enum(['starter', 'business', 'network-pro', 'not-sure']).nullish(),
  message: optionalText(2000),
  consent: z.literal(true, { message: 'Please confirm we may contact you' }),
  /** Honeypot: hidden from people, filled in by bots. */
  website: z.string().max(200).optional(),
});

const STATUSES = ['NEW', 'CONTACTED', 'DEMO_BOOKED', 'WON', 'LOST'] as const;

export const leadRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { deps } = app;

  r.post(
    '/api/public/leads',
    { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } }, schema: { tags: ['public'], body: LeadBody } },
    async (req, reply) => {
      const b = req.body;
      reply.status(201);
      // Bots get the same answer but nothing is stored.
      if (b.website) return { ok: true };
      const now = deps.now();
      await deps.sql.begin(async (tx) => {
        const [lead] = await tx<{ id: string }[]>`
          INSERT INTO leads (business_name, contact_name, email, phone, area, business_type, screens_estimate, interested_plan, message, consent_at)
          VALUES (${b.businessName}, ${b.contactName}, ${b.email}, ${b.phone}, ${b.area}, ${b.businessType}, ${b.screensEstimate ?? null},
                  ${b.interestedPlan ?? null}, ${b.message}, ${now})
          RETURNING id`;
        await tx`INSERT INTO notifications (company_id, type, message, entity_type, entity_id)
          VALUES (NULL, 'lead.new', ${`New enquiry from ${b.businessName}`}, 'lead', ${lead!.id})`;
        await audit(tx, { actorType: 'SYSTEM', action: 'lead.created', entityType: 'lead', entityId: lead!.id });
      });
      return { ok: true };
    },
  );

  r.get(
    '/api/admin/leads',
    { schema: { tags: ['admin'], querystring: z.object({ status: z.enum(STATUSES).optional() }) } },
    async (req) => {
      requireSilva(req, deps);
      return deps.sql`
        SELECT id, business_name AS "businessName", contact_name AS "contactName", email, phone, area, business_type AS "businessType",
          screens_estimate AS "screensEstimate", interested_plan AS "interestedPlan", message, status, notes,
          created_at AS "createdAt", updated_at AS "updatedAt"
        FROM leads ${req.query.status ? deps.sql`WHERE status = ${req.query.status}` : deps.sql``}
        ORDER BY created_at DESC LIMIT 500`;
    },
  );

  r.patch(
    '/api/admin/leads/:id',
    { schema: { tags: ['admin'], params: z.object({ id: uuid }), body: z.object({ status: z.enum(STATUSES), notes: optionalText(4000) }) } },
    async (req) => {
      const auth = requireSilva(req, deps);
      const [l] = await deps.sql`UPDATE leads SET status = ${req.body.status}, notes = ${req.body.notes}, updated_at = now()
        WHERE id = ${req.params.id} RETURNING id`;
      if (!l) throw notFound('Lead');
      await audit(deps.sql, { actorType: 'USER', actorId: auth.user.id, action: 'lead.updated', entityType: 'lead', entityId: req.params.id, metadata: { status: req.body.status }, ip: req.ip });
      return { ok: true };
    },
  );
};
