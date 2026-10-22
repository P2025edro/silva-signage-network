import type { DistributionPolicy } from '@silva/shared';
import type { Db } from '../db.js';

export interface PlatformSettings {
  'distribution.allow_own_screens': boolean;
  'distribution.max_advertiser_share': number;
  'distribution.slots_per_loop': number;
  'distribution.require_host_subscription': boolean;
  'devices.heartbeat_interval_seconds': number;
  'devices.offline_after_seconds': number;
  'devices.offline_cache_max_hours': number;
  'pairing.code_ttl_seconds': number;
}

export const SETTING_DEFAULTS: PlatformSettings = {
  'distribution.allow_own_screens': false,
  'distribution.max_advertiser_share': 0.4,
  'distribution.slots_per_loop': 12,
  'distribution.require_host_subscription': true,
  'devices.heartbeat_interval_seconds': 30,
  'devices.offline_after_seconds': 120,
  'devices.offline_cache_max_hours': 24,
  'pairing.code_ttl_seconds': 600,
};

/** Validation for admin edits: [type, min, max]. */
export const SETTING_RULES: Record<keyof PlatformSettings, ['boolean'] | ['number', number, number]> = {
  'distribution.allow_own_screens': ['boolean'],
  'distribution.max_advertiser_share': ['number', 0.1, 1],
  'distribution.slots_per_loop': ['number', 1, 60],
  'distribution.require_host_subscription': ['boolean'],
  'devices.heartbeat_interval_seconds': ['number', 10, 300],
  'devices.offline_after_seconds': ['number', 30, 3600],
  'devices.offline_cache_max_hours': ['number', 1, 168],
  'pairing.code_ttl_seconds': ['number', 120, 3600],
};

export async function getSettings(db: Db): Promise<PlatformSettings> {
  const rows = await db<{ key: string; value: unknown }[]>`SELECT key, value FROM platform_settings`;
  const out: Record<string, unknown> = { ...SETTING_DEFAULTS };
  for (const r of rows) if (r.key in SETTING_DEFAULTS) out[r.key] = r.value;
  return out as unknown as PlatformSettings;
}

export function distributionPolicy(s: PlatformSettings, maxVideoSeconds: number): DistributionPolicy {
  return {
    allowOwnScreens: s['distribution.allow_own_screens'],
    maxAdvertiserShare: s['distribution.max_advertiser_share'],
    slotsPerLoop: s['distribution.slots_per_loop'],
    requireHostSubscription: s['distribution.require_host_subscription'],
    maxVideoSeconds,
  };
}
