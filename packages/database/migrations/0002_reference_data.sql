-- Reference data. These are configurable starting values, not claims about
-- existing customers or installed screens.

INSERT INTO business_categories (slug, name) VALUES
  ('barbershop', 'Barbershop / Hair salon'),
  ('restaurant', 'Restaurant / Takeaway'),
  ('cafe', 'Café'),
  ('grocery', 'Grocery / Convenience'),
  ('fitness', 'Gym / Fitness'),
  ('beauty', 'Beauty / Nails'),
  ('retail', 'Retail'),
  ('education', 'Education / Training'),
  ('professional-services', 'Professional services'),
  ('community', 'Community / Non-profit'),
  ('other', 'Other')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO geographic_zones (slug, name) VALUES
  ('dublin-8', 'Dublin 8'),
  ('portobello', 'Portobello'),
  ('camden-street', 'Camden Street'),
  ('rathmines', 'Rathmines'),
  ('ranelagh', 'Ranelagh'),
  ('dublin-city-centre', 'Dublin City Centre'),
  ('cabra', 'Cabra')
ON CONFLICT (slug) DO NOTHING;

-- Draft example plans for development. price_is_draft = true: NOT approved commercial prices.
INSERT INTO subscription_plans (code, name, monthly_price_cents, price_is_draft) VALUES
  ('starter', 'Starter', 2900, true),
  ('business', 'Business', 5900, true),
  ('network-pro', 'Network Pro', 9900, true)
ON CONFLICT (code) DO NOTHING;

INSERT INTO plan_entitlements (plan_id, key, value)
SELECT p.id, e.key, e.value
FROM subscription_plans p
JOIN (VALUES
  ('starter',     'max_screens', 1), ('starter', 'max_active_campaigns', 1), ('starter', 'max_target_zones', 2),
  ('starter',     'monthly_playback_allocation', 3000), ('starter', 'max_campaign_days', 31), ('starter', 'distribution_weight', 1),
  ('starter',     'reporting_level', 1),
  ('business',    'max_screens', 3), ('business', 'max_active_campaigns', 3), ('business', 'max_target_zones', 5),
  ('business',    'monthly_playback_allocation', 9000), ('business', 'max_campaign_days', 92), ('business', 'distribution_weight', 2),
  ('business',    'reporting_level', 2),
  ('network-pro', 'max_screens', 10), ('network-pro', 'max_active_campaigns', 10), ('network-pro', 'max_target_zones', 20),
  ('network-pro', 'monthly_playback_allocation', 30000), ('network-pro', 'max_campaign_days', 365), ('network-pro', 'distribution_weight', 3),
  ('network-pro', 'reporting_level', 3)
) AS e(plan_code, key, value) ON e.plan_code = p.code
ON CONFLICT (plan_id, key) DO NOTHING;

INSERT INTO platform_settings (key, value, description) VALUES
  ('distribution.allow_own_screens', 'false', 'Include an advertiser''s own screens when distributing its campaigns'),
  ('distribution.max_advertiser_share', '0.4', 'Max share of a loop one advertiser may take when others are eligible'),
  ('distribution.slots_per_loop', '12', 'Number of ad slots in one playlist loop'),
  ('distribution.require_host_subscription', 'true', 'Host establishments must have an active subscription to receive network ads'),
  ('devices.heartbeat_interval_seconds', '30', 'How often players send a heartbeat'),
  ('devices.offline_after_seconds', '120', 'Screen shown offline after this long without a heartbeat'),
  ('devices.offline_cache_max_hours', '24', 'Longest a player may keep playing a cached playlist without reaching the API'),
  ('pairing.code_ttl_seconds', '600', 'Pairing code lifetime')
ON CONFLICT (key) DO NOTHING;
