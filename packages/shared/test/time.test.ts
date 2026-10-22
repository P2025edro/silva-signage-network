import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLocationOpen, isWithinSchedule, localParts, nextQuarterHour, validateSchedule } from '../src/index.js';

test('local time follows Irish winter time (GMT) and summer time (IST)', () => {
  assert.deepEqual(localParts(new Date('2026-01-14T12:00:00Z')), { isoWeekday: 3, minuteOfDay: 12 * 60, date: '2026-01-14' });
  assert.deepEqual(localParts(new Date('2026-07-15T12:00:00Z')), { isoWeekday: 3, minuteOfDay: 13 * 60, date: '2026-07-15' });
});

test('spring-forward night: 01:00 UTC jumps local clock from 01:00 to 02:00', () => {
  assert.equal(localParts(new Date('2026-03-29T00:30:00Z')).minuteOfDay, 30);
  assert.equal(localParts(new Date('2026-03-29T01:30:00Z')).minuteOfDay, 2 * 60 + 30);
});

test('fall-back night: local date and weekday stay correct', () => {
  const p = localParts(new Date('2026-10-25T00:30:00Z')); // 01:30 IST, Sunday
  assert.equal(p.isoWeekday, 7);
  assert.equal(p.minuteOfDay, 90);
  assert.equal(localParts(new Date('2026-10-25T01:30:00Z')).minuteOfDay, 90); // 01:30 GMT again
});

test('schedule is evaluated in local time, not UTC', () => {
  const weekdayMornings = { days: [1, 2, 3, 4, 5], startMinute: 9 * 60, endMinute: 12 * 60 };
  // 10:30 UTC in July = 11:30 Dublin → inside
  assert.equal(isWithinSchedule(weekdayMornings, new Date('2026-07-15T10:30:00Z'), 'Europe/Dublin'), true);
  // 11:30 UTC in July = 12:30 Dublin → outside (end exclusive)
  assert.equal(isWithinSchedule(weekdayMornings, new Date('2026-07-15T11:30:00Z'), 'Europe/Dublin'), false);
  // Saturday
  assert.equal(isWithinSchedule(weekdayMornings, new Date('2026-07-18T10:00:00Z'), 'Europe/Dublin'), false);
  assert.equal(isWithinSchedule(null, new Date(), 'Europe/Dublin'), true);
});

test('opening hours support overnight intervals', () => {
  const hours = { fri: [{ open: '18:00', close: '02:00' }] };
  assert.equal(isLocationOpen(hours, new Date('2026-07-17T20:00:00Z'), 'Europe/Dublin'), true); // Fri 21:00
  assert.equal(isLocationOpen(hours, new Date('2026-07-18T00:30:00Z'), 'Europe/Dublin'), true); // Sat 01:30
  assert.equal(isLocationOpen(hours, new Date('2026-07-18T01:30:00Z'), 'Europe/Dublin'), false); // Sat 02:30
  assert.equal(isLocationOpen(hours, new Date('2026-07-17T10:00:00Z'), 'Europe/Dublin'), false); // Fri 11:00
  assert.equal(isLocationOpen(null, new Date(), 'Europe/Dublin'), true);
});

test('next quarter hour is strictly later', () => {
  assert.equal(nextQuarterHour(new Date('2026-07-15T11:00:00Z')).toISOString(), '2026-07-15T11:15:00.000Z');
  assert.equal(nextQuarterHour(new Date('2026-07-15T11:14:59Z')).toISOString(), '2026-07-15T11:15:00.000Z');
});

test('schedule validation', () => {
  assert.deepEqual(validateSchedule({ days: [1], startMinute: 540, endMinute: 600 }), []);
  assert.ok(validateSchedule({ days: [], startMinute: 540, endMinute: 600 }).length > 0);
  assert.ok(validateSchedule({ days: [8], startMinute: 540, endMinute: 600 }).length > 0);
  assert.ok(validateSchedule({ days: [1], startMinute: 545, endMinute: 600 }).length > 0);
  assert.ok(validateSchedule({ days: [1], startMinute: 600, endMinute: 600 }).length > 0);
});
