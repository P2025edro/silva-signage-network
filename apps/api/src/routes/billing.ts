import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type Stripe from 'stripe';
import { z } from 'zod';
import { requireCompany, requireSilva } from '../auth/session.js';
import type { Db } from '../db.js';
import { audit } from '../lib/audit.js';
import { badRequest, HttpError, notFound } from '../lib/errors.js';
import { CompanyParams, uuid } from '../lib/http.js';
import { companySubscriptionState } from '../services/entitlements.js';
import { regeneratePlaylists } from '../services/playlists.js';
import type { Deps } from '../types.js';

const notConfigured = () =>
  new HttpError(503, 'BILLING_NOT_CONFIGURED', 'Online billing is not configured yet. Contact Silva Solutions to set up your subscription.');

const STRIPE_STATUS: Record<string, string> = {
  incomplete: 'INCOMPLETE',
  incomplete_expired: 'CANCELED',
  trialing: 'TRIALING',
  active: 'ACTIVE',
  past_due: 'PAST_DUE',
  canceled: 'CANCELED',
  unpaid: 'UNPAID',
  paused: 'PAST_DUE',
};

/** Mirrors a Stripe subscription into our table. Only called with signature-verified events. */
async function syncStripeSubscription(tx: Db, sub: Stripe.Subscription): Promise<string | null> {
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  const [company] = await tx<{ id: string }[]>`
    SELECT id FROM companies WHERE stripe_customer_id = ${customerId} OR id::text = ${sub.metadata?.company_id ?? ''} LIMIT 1`;
  if (!company) return null;
  const item = sub.items.data[0];
  const priceId = item?.price.id;
  const [plan] = await tx<{ id: string }[]>`SELECT id FROM subscription_plans WHERE stripe_price_id = ${priceId ?? ''}`;
  if (!plan) throw new Error(`No plan mapped to Stripe price ${priceId}`);
  const status = STRIPE_STATUS[sub.status] ?? 'INCOMPLETE';
  // Period fields moved from subscription to item in newer Stripe API versions.
  const anySub = sub as unknown as { current_period_start?: number; current_period_end?: number };
  const anyItem = item as unknown as { current_period_start?: number; current_period_end?: number } | undefined;
  const start = new Date((anyItem?.current_period_start ?? anySub.current_period_start ?? sub.start_date) * 1000);
  const end = new Date((anyItem?.current_period_end ?? anySub.current_period_end ?? sub.start_date + 30 * 86400) * 1000);

  await tx`UPDATE companies SET stripe_customer_id = ${customerId} WHERE id = ${company.id} AND stripe_customer_id IS NULL`;
  const [existing] = await tx<{ id: string }[]>`SELECT id FROM subscriptions WHERE stripe_subscription_id = ${sub.id}`;
  if (existing) {
    await tx`UPDATE subscriptions SET plan_id = ${plan.id}, status = ${status}, current_period_start = ${start}, current_period_end = ${end},
      cancel_at_period_end = ${sub.cancel_at_period_end}, updated_at = now() WHERE id = ${existing.id}`;
  } else {
    // A verified paid subscription supersedes any manual (pilot) entitlement.
    await tx`UPDATE subscriptions SET status = 'CANCELED', updated_at = now(), note = coalesce(note, '') || ' Superseded by Stripe subscription.'
      WHERE company_id = ${company.id} AND source = 'MANUAL' AND status IN ('INCOMPLETE', 'TRIALING', 'ACTIVE', 'PAST_DUE')`;
    await tx`INSERT INTO subscriptions (company_id, plan_id, status, source, stripe_subscription_id, current_period_start, current_period_end, cancel_at_period_end)
      VALUES (${company.id}, ${plan.id}, ${status}, 'STRIPE', ${sub.id}, ${start}, ${end}, ${sub.cancel_at_period_end})`;
  }
  return company.id;
}

export const billingRoutes: FastifyPluginAsync = async (app) => {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { deps } = app;

  r.get('/api/plans', { schema: { tags: ['billing'] } }, async () => {
    const plans = await deps.sql`
      SELECT p.id, p.code, p.name, p.monthly_price_cents AS "monthlyPriceCents", p.currency, p.price_is_draft AS "priceIsDraft",
        p.stripe_price_id IS NOT NULL AS "onlineCheckout", p.stripe_price_id AS "stripePriceId", p.active,
        COALESCE((SELECT json_object_agg(e.key, e.value) FROM plan_entitlements e WHERE e.plan_id = p.id), '{}'::json) AS entitlements
      FROM subscription_plans p WHERE p.active ORDER BY p.monthly_price_cents`;
    return plans;
  });

  r.get('/api/companies/:companyId/billing', { schema: { tags: ['billing'], params: CompanyParams } }, async (req) => {
    requireCompany(req, deps, req.params.companyId, 'VIEW');
    const state = await companySubscriptionState(deps.sql, req.params.companyId, deps.now());
    const invoices = await deps.sql`
      SELECT provider_event_id AS id, type, amount_cents AS "amountCents", currency, received_at AS "receivedAt",
        payload -> 'data' -> 'object' ->> 'hosted_invoice_url' AS "invoiceUrl"
      FROM billing_events WHERE company_id = ${req.params.companyId} AND type LIKE 'invoice.%' ORDER BY received_at DESC LIMIT 50`;
    return { ...state, invoices, onlineBillingAvailable: Boolean(deps.stripe) };
  });

  r.post(
    '/api/companies/:companyId/billing/checkout',
    { schema: { tags: ['billing'], params: CompanyParams, body: z.object({ planCode: z.string().max(40) }) } },
    async (req) => {
      requireCompany(req, deps, req.params.companyId, 'OWNER');
      if (!deps.stripe) throw notConfigured();
      const [plan] = await deps.sql<
        { stripe_price_id: string | null }[]
      >`SELECT stripe_price_id FROM subscription_plans WHERE code = ${req.body.planCode} AND active`;
      if (!plan) throw notFound('Plan');
      if (!plan.stripe_price_id) throw badRequest('This plan is not yet available for online checkout');
      const [c] = await deps.sql<
        { email: string; stripe_customer_id: string | null }[]
      >`SELECT email, stripe_customer_id FROM companies WHERE id = ${req.params.companyId}`;
      const origin = deps.config.webOrigins[0];
      const session = await deps.stripe.checkout.sessions.create({
        mode: 'subscription',
        line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
        ...(c!.stripe_customer_id ? { customer: c!.stripe_customer_id } : { customer_email: c!.email }),
        client_reference_id: req.params.companyId,
        subscription_data: { metadata: { company_id: req.params.companyId } },
        metadata: { company_id: req.params.companyId },
        success_url: `${origin}/portal/billing?checkout=success`,
        cancel_url: `${origin}/portal/billing?checkout=cancelled`,
      });
      return { url: session.url };
    },
  );

  r.post('/api/companies/:companyId/billing/portal', { schema: { tags: ['billing'], params: CompanyParams } }, async (req) => {
    requireCompany(req, deps, req.params.companyId, 'OWNER');
    if (!deps.stripe) throw notConfigured();
    const [c] = await deps.sql<{ stripe_customer_id: string | null }[]>`SELECT stripe_customer_id FROM companies WHERE id = ${req.params.companyId}`;
    if (!c?.stripe_customer_id) throw badRequest('No online subscription exists for this account yet');
    const session = await deps.stripe.billingPortal.sessions.create({
      customer: c.stripe_customer_id,
      return_url: `${deps.config.webOrigins[0]}/portal/billing`,
    });
    return { url: session.url };
  });

  // ---- Webhook ---------------------------------------------------------------
  await app.register(async (scoped) => {
    // Signature verification needs the exact raw bytes.
    scoped.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    scoped.post('/api/billing/stripe/webhook', { config: { rateLimit: false }, schema: { hide: true } }, async (req, reply) => {
      if (!deps.stripe || !deps.config.STRIPE_WEBHOOK_SECRET) throw notConfigured();
      const sig = req.headers['stripe-signature'];
      if (typeof sig !== 'string') throw badRequest('Missing signature');
      let event: Stripe.Event;
      try {
        event = deps.stripe.webhooks.constructEvent(req.body as Buffer, sig, deps.config.STRIPE_WEBHOOK_SECRET);
      } catch {
        throw new HttpError(400, 'INVALID_SIGNATURE', 'Webhook signature verification failed');
      }
      const result = await handleStripeEvent(deps, event);
      if (result.affectsDistribution) await regeneratePlaylists(deps);
      return reply.send({ received: true, duplicate: result.duplicate });
    });
  });

  // ---- Admin: plans and manual subscriptions --------------------------------
  r.get('/api/admin/billing', { schema: { tags: ['admin'] } }, async (req) => {
    requireSilva(req, deps, { superAdminOnly: true });
    const events = await deps.sql`
      SELECT b.id, b.provider_event_id AS "providerEventId", b.type, b.amount_cents AS "amountCents", b.currency, b.received_at AS "receivedAt",
        b.processed_at AS "processedAt", b.processing_error AS "processingError", c.name AS "companyName"
      FROM billing_events b LEFT JOIN companies c ON c.id = b.company_id ORDER BY b.received_at DESC LIMIT 100`;
    return {
      stripeConfigured: Boolean(deps.stripe),
      webhookConfigured: Boolean(deps.config.STRIPE_WEBHOOK_SECRET),
      plansMappedToStripe: (await deps.sql`SELECT count(*)::int AS n FROM subscription_plans WHERE stripe_price_id IS NOT NULL`)[0]!.n,
      events,
    };
  });

  r.get('/api/admin/subscriptions', { schema: { tags: ['admin'] } }, async (req) => {
    requireSilva(req, deps, { superAdminOnly: true });
    return deps.sql`
      SELECT s.id, s.company_id AS "companyId", c.name AS "companyName", c.is_dev_fixture AS "isDevFixture", p.name AS "planName", p.code AS "planCode",
        s.status, s.source, s.current_period_start AS "currentPeriodStart", s.current_period_end AS "currentPeriodEnd",
        s.cancel_at_period_end AS "cancelAtPeriodEnd", s.note, s.created_at AS "createdAt"
      FROM subscriptions s JOIN companies c ON c.id = s.company_id JOIN subscription_plans p ON p.id = s.plan_id
      ORDER BY s.created_at DESC LIMIT 500`;
  });

  r.post(
    '/api/admin/companies/:companyId/subscriptions/manual',
    {
      schema: {
        tags: ['admin'],
        params: CompanyParams,
        body: z.object({ planCode: z.string().max(40), periodDays: z.number().int().min(1).max(366), note: z.string().trim().min(3).max(300) }),
      },
    },
    async (req, reply) => {
      const auth = requireSilva(req, deps, { superAdminOnly: true });
      const now = deps.now();
      const id = await deps.sql.begin(async (tx) => {
        const [plan] = await tx<{ id: string }[]>`SELECT id FROM subscription_plans WHERE code = ${req.body.planCode}`;
        if (!plan) throw notFound('Plan');
        const [co] = await tx`SELECT id FROM companies WHERE id = ${req.params.companyId} AND deleted_at IS NULL`;
        if (!co) throw notFound('Company');
        const [stripeLive] = await tx`SELECT 1 FROM subscriptions WHERE company_id = ${req.params.companyId} AND source = 'STRIPE'
          AND status IN ('INCOMPLETE', 'TRIALING', 'ACTIVE', 'PAST_DUE')`;
        if (stripeLive) throw badRequest('This company has a live Stripe subscription; change it in Stripe instead');
        await tx`UPDATE subscriptions SET status = 'CANCELED', updated_at = now() WHERE company_id = ${req.params.companyId}
          AND source = 'MANUAL' AND status IN ('INCOMPLETE', 'TRIALING', 'ACTIVE', 'PAST_DUE')`;
        // MANUAL subscriptions grant entitlements (pilots, development) and are never counted as revenue.
        const [s] = await tx<{ id: string }[]>`
          INSERT INTO subscriptions (company_id, plan_id, status, source, current_period_start, current_period_end, note, created_by)
          VALUES (${req.params.companyId}, ${plan.id}, 'ACTIVE', 'MANUAL', ${now}, ${new Date(now.getTime() + req.body.periodDays * 86_400_000)}, ${req.body.note}, ${auth.user.id})
          RETURNING id`;
        await audit(tx, {
          actorType: 'USER',
          actorId: auth.user.id,
          companyId: req.params.companyId,
          action: 'subscription.manual_granted',
          entityType: 'subscription',
          entityId: s!.id,
          metadata: req.body,
          ip: req.ip,
        });
        return s!.id;
      });
      await regeneratePlaylists(deps);
      reply.status(201);
      return { id };
    },
  );

  r.post('/api/admin/subscriptions/:id/cancel', { schema: { tags: ['admin'], params: z.object({ id: uuid }) } }, async (req) => {
    const auth = requireSilva(req, deps, { superAdminOnly: true });
    const [s] = await deps.sql<{ company_id: string; source: string }[]>`SELECT company_id, source FROM subscriptions WHERE id = ${req.params.id}`;
    if (!s) throw notFound('Subscription');
    if (s.source === 'STRIPE') throw badRequest('Cancel Stripe subscriptions in Stripe; the change syncs back automatically');
    await deps.sql`UPDATE subscriptions SET status = 'CANCELED', updated_at = now() WHERE id = ${req.params.id}`;
    await audit(deps.sql, {
      actorType: 'USER',
      actorId: auth.user.id,
      companyId: s.company_id,
      action: 'subscription.manual_cancelled',
      entityType: 'subscription',
      entityId: req.params.id,
      ip: req.ip,
    });
    await regeneratePlaylists(deps);
    return { ok: true };
  });

  r.put(
    '/api/admin/plans/:id',
    {
      schema: {
        tags: ['admin'],
        params: z.object({ id: uuid }),
        body: z.object({
          name: z.string().trim().min(2).max(60),
          monthlyPriceCents: z.number().int().min(0).max(10_000_00),
          priceIsDraft: z.boolean(),
          stripePriceId: z
            .string()
            .trim()
            .max(100)
            .nullish()
            .transform((v) => v || null),
          active: z.boolean(),
          entitlements: z.record(
            z.enum([
              'max_screens',
              'max_active_campaigns',
              'max_target_zones',
              'monthly_playback_allocation',
              'max_campaign_days',
              'distribution_weight',
              'reporting_level',
            ]),
            z.number().int().min(0).max(10_000_000),
          ),
        }),
      },
    },
    async (req) => {
      const auth = requireSilva(req, deps, { superAdminOnly: true });
      const b = req.body;
      await deps.sql.begin(async (tx) => {
        const [p] = await tx`UPDATE subscription_plans SET name = ${b.name}, monthly_price_cents = ${b.monthlyPriceCents}, price_is_draft = ${b.priceIsDraft},
          stripe_price_id = ${b.stripePriceId}, active = ${b.active} WHERE id = ${req.params.id} RETURNING id`;
        if (!p) throw notFound('Plan');
        for (const [key, value] of Object.entries(b.entitlements)) {
          await tx`INSERT INTO plan_entitlements (plan_id, key, value) VALUES (${req.params.id}, ${key}, ${value})
            ON CONFLICT (plan_id, key) DO UPDATE SET value = EXCLUDED.value`;
        }
        await audit(tx, {
          actorType: 'USER',
          actorId: auth.user.id,
          action: 'plan.updated',
          entityType: 'plan',
          entityId: req.params.id,
          metadata: b,
          ip: req.ip,
        });
      });
      await regeneratePlaylists(deps);
      return { ok: true };
    },
  );
};

/** Idempotent: the provider event id is unique, so a redelivered event is recorded once and processed once. */
export async function handleStripeEvent(deps: Deps, event: Stripe.Event): Promise<{ duplicate: boolean; affectsDistribution: boolean }> {
  return deps.sql.begin(async (tx) => {
    const obj = event.data.object as unknown as Record<string, unknown>;
    const amount = typeof obj.amount_paid === 'number' ? obj.amount_paid : typeof obj.amount_due === 'number' ? obj.amount_due : null;
    const [inserted] = await tx<{ id: string }[]>`
      INSERT INTO billing_events (provider, provider_event_id, type, amount_cents, currency, payload)
      VALUES ('stripe', ${event.id}, ${event.type}, ${amount}, ${typeof obj.currency === 'string' ? obj.currency.toUpperCase() : null}, ${tx.json(event as never)})
      ON CONFLICT (provider, provider_event_id) DO NOTHING RETURNING id`;
    if (!inserted) return { duplicate: true, affectsDistribution: false };

    let companyId: string | null = null;
    let affects = false;
    try {
      // Savepoint: a processing failure is recorded without losing the event itself.
      await tx.savepoint(async (sp) => {
        if (event.type.startsWith('customer.subscription.')) {
          companyId = await syncStripeSubscription(sp, event.data.object as Stripe.Subscription);
          affects = true;
        } else if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
          const customer = obj.customer as string | undefined;
          const [c] = await sp<{ id: string }[]>`SELECT id FROM companies WHERE stripe_customer_id = ${customer ?? ''}`;
          companyId = c?.id ?? null;
          if (companyId && event.type === 'invoice.payment_failed') {
            await sp`INSERT INTO notifications (company_id, type, message) VALUES (${companyId}, 'billing.payment_failed',
              'A subscription payment failed. Update your payment method to keep your adverts running.')`;
            await sp`INSERT INTO notifications (company_id, type, message) VALUES (NULL, 'billing.payment_failed', ${`Payment failed for company ${companyId}`})`;
          }
        }
      });
      await tx`UPDATE billing_events SET company_id = ${companyId}, processed_at = now() WHERE id = ${inserted.id}`;
    } catch (e) {
      affects = false;
      await tx`UPDATE billing_events SET processing_error = ${(e as Error).message.slice(0, 500)} WHERE id = ${inserted.id}`;
    }
    await audit(tx, { actorType: 'PROVIDER', companyId, action: `billing.${event.type}`, entityType: 'billing_event', entityId: inserted.id });
    return { duplicate: false, affectsDistribution: affects };
  });
}
