import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateLoop, smoothWeightedOrder, type AllocationCandidate } from '../src/index.js';

const cand = (campaignId: string, advertiserId: string, weight = 3, deliveryRatio = 0, creativeCount = 1): AllocationCandidate => ({
  campaignId,
  advertiserId,
  weight,
  deliveryRatio,
  creativeCount,
});

const total = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);

test('slots are shared in proportion to weight', () => {
  const r = allocateLoop([cand('a', 'A', 3), cand('b', 'B', 6), cand('c', 'C', 3)], 12, 1);
  assert.deepEqual(Object.fromEntries(r.slots), { a: 1, b: 2, c: 1 }); // 3:6:3 compressed by 3
  assert.equal(r.order.length, 4);
});

test('one advertiser cannot monopolise the loop when others are eligible', () => {
  const r = allocateLoop([cand('big', 'A', 30), cand('small', 'B', 1)], 12, 0.4);
  const big = r.slots.get('big')!;
  const sum = total(r.slots);
  assert.ok(big / sum <= 0.5, `big has ${big}/${sum}`);
  // Uncapped, Sainte-Laguë would give 'big' 11 of 12.
  const uncapped = allocateLoop([cand('big', 'A', 30), cand('small', 'B', 1)], 12, 1);
  assert.ok(uncapped.slots.get('big')! / total(uncapped.slots) > 0.8);
});

test('cap applies across all of one advertiser\'s campaigns', () => {
  const r = allocateLoop([cand('a1', 'A', 10), cand('a2', 'A', 10), cand('a3', 'A', 10), cand('b', 'B', 1)], 12, 0.4);
  const aSlots = r.slots.get('a1')! + r.slots.get('a2')! + r.slots.get('a3')!;
  // floor(12 × 0.4) = 4 → advertiser A keeps at most 4 of the original 12 (before compression)
  assert.ok(aSlots / total(r.slots) <= 4 / 5 + 1e-9);
  assert.ok(r.slots.get('b')! >= 1);
});

test('when inventory is short, least-delivered campaigns are selected and the rest reported', () => {
  const candidates = [cand('x', 'X', 3, 0.9), cand('y', 'Y', 3, 0.1), cand('z', 'Z', 3, 0.5)];
  const r = allocateLoop(candidates, 2, 1);
  assert.deepEqual([...r.slots.keys()].sort(), ['y', 'z']);
  assert.deepEqual(r.displaced, ['x']);
});

test('allocation is deterministic regardless of input order', () => {
  const cs = [cand('a', 'A', 3), cand('b', 'B', 5), cand('c', 'C', 2), cand('d', 'A', 4)];
  const r1 = allocateLoop(cs, 12, 0.4);
  const r2 = allocateLoop([...cs].reverse(), 12, 0.4);
  assert.deepEqual(r1.order, r2.order);
  assert.deepEqual([...r1.slots].sort(), [...r2.slots].sort());
});

test('a lone campaign is not repeated needlessly, but keeps all its creatives', () => {
  assert.deepEqual(Object.fromEntries(allocateLoop([cand('a', 'A', 3, 0, 1)], 12, 0.4).slots), { a: 1 });
  assert.deepEqual(Object.fromEntries(allocateLoop([cand('a', 'A', 3, 0, 3)], 12, 0.4).slots), { a: 3 });
});

test('smooth ordering spreads repeated campaigns apart', () => {
  const order = smoothWeightedOrder(new Map([['a', 3], ['b', 1], ['c', 2]]));
  assert.equal(order.length, 6);
  for (let i = 1; i < order.length; i++) {
    if (order[i] === 'a') assert.notEqual(order[i - 1], 'a', `adjacent a at ${i}: ${order.join(',')}`);
  }
});

test('empty input gives an empty loop', () => {
  const r = allocateLoop([], 12, 0.4);
  assert.equal(r.order.length, 0);
});

test('rejects invalid policy values', () => {
  assert.throws(() => allocateLoop([], 0, 0.4));
  assert.throws(() => allocateLoop([], 12, 0));
});
