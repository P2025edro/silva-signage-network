import type { Db } from '../db.js';

export type EntitlementKey =
  'max_screens' | 'max_active_campaigns' | 'max_target_zones' | 'monthly_playback_allocation' | 'max_campaign_days' | 'distribution_weight' | 'reporting_level';

export interface CompanySubscriptionState {
  subscription: {
    id: string;
    planCode: string;
    planName: string;
    status: string;
    source: 'STRIPE' | 'MANUAL';
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
  } | null;
  active: boolean;
  entitlements: Partial<Record<EntitlementKey, number>>;
  playsThisPeriod: number;
}

export async function companySubscriptionState(db: Db, companyId: string, now: Date): Promise<CompanySubscriptionState> {
  const [s] = await db<
    {
      id: string;
      plan_id: string;
      code: string;
      name: string;
      status: string;
      source: 'STRIPE' | 'MANUAL';
      current_period_start: Date;
      current_period_end: Date;
      cancel_at_period_end: boolean;
    }[]
  >`
    SELECT s.id, s.plan_id, p.code, p.name, s.status, s.source, s.current_period_start, s.current_period_end, s.cancel_at_period_end
    FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id
    WHERE s.company_id = ${companyId} AND s.status IN ('INCOMPLETE', 'TRIALING', 'ACTIVE', 'PAST_DUE')
    ORDER BY s.created_at DESC LIMIT 1`;
  if (!s) return { subscription: null, active: false, entitlements: {}, playsThisPeriod: 0 };

  const ents = await db<{ key: EntitlementKey; value: number }[]>`SELECT key, value FROM plan_entitlements WHERE plan_id = ${s.plan_id}`;
  const [playRow] = await db<{ plays: number }[]>`
    SELECT count(*)::int AS plays FROM playback_events
    WHERE advertiser_company_id = ${companyId} AND type = 'STARTED' AND occurred_at >= ${s.current_period_start}`;
  const plays = playRow?.plays ?? 0;
  return {
    subscription: {
      id: s.id,
      planCode: s.code,
      planName: s.name,
      status: s.status,
      source: s.source,
      currentPeriodStart: s.current_period_start,
      currentPeriodEnd: s.current_period_end,
      cancelAtPeriodEnd: s.cancel_at_period_end,
    },
    active: (s.status === 'ACTIVE' || s.status === 'TRIALING') && s.current_period_end > now,
    entitlements: Object.fromEntries(ents.map((e) => [e.key, e.value])),
    playsThisPeriod: plays,
  };
}
