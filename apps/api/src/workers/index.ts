import { nextCampaignStatus, type CampaignStatus } from '@silva/shared';
import { audit } from '../lib/audit.js';
import { regeneratePlaylists, screensNeedingRegeneration } from '../services/playlists.js';
import type { Deps } from '../types.js';

const LOCK_SCHEDULER = 841_001;
const LOCK_MAINTENANCE = 841_002;

/** Runs `fn` only if no other worker instance holds the lock (safe to run several workers). */
async function withLock(deps: Deps, key: number, fn: () => Promise<void>): Promise<boolean> {
  return deps.sql.begin(async (tx) => {
    const [{ ok }] = (await tx`SELECT pg_try_advisory_xact_lock(${key}) AS ok`) as unknown as [{ ok: boolean }];
    if (!ok) return false;
    await fn();
    return true;
  });
}

/** Campaign scheduler: moves campaigns along their timeline and keeps playlists fresh. */
export async function schedulerTick(deps: Deps): Promise<{ transitions: number; regenerated: number }> {
  let transitions = 0;
  let regenerated = 0;
  await withLock(deps, LOCK_SCHEDULER, async () => {
    const now = deps.now();
    const rows = await deps.sql<{ id: string; company_id: string; status: CampaignStatus; start_at: Date; end_at: Date }[]>`
      SELECT id, company_id, status, start_at, end_at FROM campaigns
      WHERE deleted_at IS NULL AND status IN ('SCHEDULED', 'ACTIVE', 'PAUSED')`;
    for (const c of rows) {
      const next = nextCampaignStatus({ action: 'SYSTEM_TICK', actor: 'SILVA', current: c.status, startAt: c.start_at, endAt: c.end_at, now });
      if (next === c.status) continue;
      await deps.sql.begin(async (tx) => {
        const updated = await tx`UPDATE campaigns SET status = ${next}, updated_at = ${now} WHERE id = ${c.id} AND status = ${c.status} RETURNING id`;
        if (updated.length) {
          transitions++;
          await audit(tx, {
            actorType: 'SYSTEM',
            companyId: c.company_id,
            action: 'campaign.status_advanced',
            entityType: 'campaign',
            entityId: c.id,
            metadata: { from: c.status, to: next },
          });
        }
      });
    }
    const results = transitions > 0 ? await regeneratePlaylists(deps) : await regenerateExpired(deps);
    regenerated = results.filter((r) => r.changed).length;
  });
  return { transitions, regenerated };
}

async function regenerateExpired(deps: Deps) {
  const ids = await screensNeedingRegeneration(deps.sql, deps.now());
  return ids.length ? regeneratePlaylists(deps, ids) : [];
}

/** Retention and housekeeping. Periods are documented in docs/SECURITY.md (data retention). */
export async function maintenanceTick(deps: Deps): Promise<void> {
  await withLock(deps, LOCK_MAINTENANCE, async () => {
    const now = deps.now();
    const days = (n: number) => new Date(now.getTime() - n * 86_400_000);
    await deps.sql`UPDATE device_pairing_sessions SET status = 'EXPIRED' WHERE status = 'PENDING' AND expires_at <= ${now}`;
    await deps.sql`DELETE FROM device_pairing_sessions WHERE created_at < ${days(7)}`;
    await deps.sql`UPDATE screen_commands SET status = 'EXPIRED' WHERE status IN ('PENDING', 'DELIVERED') AND expires_at <= ${now}`;
    await deps.sql`DELETE FROM screen_heartbeats WHERE received_at < ${days(30)}`;
    await deps.sql`DELETE FROM sessions WHERE expires_at < ${days(30)} OR revoked_at < ${days(30)}`;
  });
}

export function startWorkers(deps: Deps, log: (msg: string, err?: unknown) => void): () => void {
  let stopped = false;
  const loop = (name: string, everyMs: number, fn: () => Promise<unknown>) => {
    const run = async () => {
      if (stopped) return;
      try {
        await fn();
      } catch (e) {
        log(`${name} failed`, e);
      }
      if (!stopped) timer = setTimeout(run, everyMs);
    };
    let timer = setTimeout(run, 1000);
    return () => clearTimeout(timer);
  };
  const stops = [loop('scheduler', 30_000, () => schedulerTick(deps)), loop('maintenance', 10 * 60_000, () => maintenanceTick(deps))];
  return () => {
    stopped = true;
    stops.forEach((s) => s());
  };
}
