/**
 * Loop allocation.
 *
 * Policy (measurable, documented in docs/CAMPAIGN_ENGINE.md):
 *  1. Selection. If more campaigns are eligible than there are slots, the
 *     least-delivered (relative to their advertiser's allocation) go first,
 *     then higher weight, then campaign id. The rest are reported as displaced.
 *  2. Minimum guarantee. Every selected campaign gets one slot.
 *  3. Proportional share. Remaining slots go one at a time by the
 *     Sainte-Laguë method on weight = plan distribution weight × priority.
 *  4. Anti-monopoly cap. When two or more advertisers are selected, no
 *     advertiser may hold more than floor(slots × maxAdvertiserShare) slots
 *     (or its minimum guarantee, if larger). Slots nobody can take are left
 *     out, which shortens the loop rather than over-serving one advertiser.
 *  5. Compression. Slot counts are divided by their largest common divisor
 *     that still lets each campaign show all of its creatives (or as many as
 *     it had slots), so a lone campaign does not repeat itself twelve times.
 *  6. Ordering. Smooth weighted round-robin interleaves campaigns so each
 *     one's slots are spread evenly through the loop.
 */

export interface AllocationCandidate {
  campaignId: string;
  advertiserId: string;
  weight: number;
  /** Plays already delivered ÷ allocation, 0..1+. Lower = more in need. */
  deliveryRatio: number;
  creativeCount: number;
}

export interface AllocationResult {
  slots: Map<string, number>;
  displaced: string[];
  /** Campaign ids in loop order. */
  order: string[];
}

export function allocateLoop(
  candidates: AllocationCandidate[],
  slotsPerLoop: number,
  maxAdvertiserShare: number,
): AllocationResult {
  if (!Number.isInteger(slotsPerLoop) || slotsPerLoop < 1) throw new Error('slotsPerLoop must be a positive integer');
  if (!(maxAdvertiserShare > 0 && maxAdvertiserShare <= 1)) throw new Error('maxAdvertiserShare must be in (0, 1]');

  const ranked = [...candidates].sort(
    (a, b) => a.deliveryRatio - b.deliveryRatio || b.weight - a.weight || a.campaignId.localeCompare(b.campaignId),
  );
  const selected = ranked.slice(0, slotsPerLoop);
  const displaced = ranked.slice(slotsPerLoop).map((c) => c.campaignId);

  const slots = new Map<string, number>();
  if (selected.length === 0) return { slots, displaced, order: [] };

  const perAdvertiser = new Map<string, number>();
  for (const c of selected) {
    slots.set(c.campaignId, 1);
    perAdvertiser.set(c.advertiserId, (perAdvertiser.get(c.advertiserId) ?? 0) + 1);
  }

  const multipleAdvertisers = perAdvertiser.size >= 2;
  const baseCap = multipleAdvertisers ? Math.max(1, Math.floor(slotsPerLoop * maxAdvertiserShare)) : slotsPerLoop;
  const capFor = (guaranteed: number) => Math.max(baseCap, guaranteed);
  const guaranteedByAdvertiser = new Map(perAdvertiser);

  let remaining = slotsPerLoop - selected.length;
  while (remaining > 0) {
    let best: AllocationCandidate | null = null;
    let bestQuotient = -1;
    for (const c of selected) {
      const advSlots = perAdvertiser.get(c.advertiserId)!;
      if (advSlots >= capFor(guaranteedByAdvertiser.get(c.advertiserId)!)) continue;
      const s = slots.get(c.campaignId)!;
      const quotient = c.weight / (2 * s + 1);
      if (
        quotient > bestQuotient ||
        (quotient === bestQuotient && best !== null && c.campaignId.localeCompare(best.campaignId) < 0)
      ) {
        best = c;
        bestQuotient = quotient;
      }
    }
    if (!best) break; // everyone capped: shorter loop instead of monopoly
    slots.set(best.campaignId, slots.get(best.campaignId)! + 1);
    perAdvertiser.set(best.advertiserId, perAdvertiser.get(best.advertiserId)! + 1);
    remaining--;
  }

  compress(slots, selected);
  return { slots, displaced, order: smoothWeightedOrder(slots) };
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function compress(slots: Map<string, number>, selected: AllocationCandidate[]): void {
  const counts = [...slots.values()];
  const g = counts.reduce(gcd);
  for (let d = g; d > 1; d--) {
    if (g % d !== 0) continue;
    const keepsCreatives = selected.every((c) => {
      const s = slots.get(c.campaignId)!;
      return s / d >= Math.min(c.creativeCount, s);
    });
    if (keepsCreatives) {
      for (const [id, s] of slots) slots.set(id, s / d);
      return;
    }
  }
}

/** Smooth weighted round-robin (as used by nginx): deterministic and evenly spread. */
export function smoothWeightedOrder(slots: Map<string, number>): string[] {
  const ids = [...slots.keys()].sort();
  const total = ids.reduce((sum, id) => sum + slots.get(id)!, 0);
  const current = new Map(ids.map((id) => [id, 0]));
  const order: string[] = [];
  for (let i = 0; i < total; i++) {
    let pick = ids[0]!;
    for (const id of ids) {
      current.set(id, current.get(id)! + slots.get(id)!);
      if (current.get(id)! > current.get(pick)!) pick = id;
    }
    current.set(pick, current.get(pick)! - total);
    order.push(pick);
  }
  return order;
}
