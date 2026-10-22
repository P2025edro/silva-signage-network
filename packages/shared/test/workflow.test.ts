import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowError, nextCampaignStatus, type TransitionInput } from '../src/index.js';

const base = {
  startAt: new Date('2026-07-10T00:00:00Z'),
  endAt: new Date('2026-07-31T00:00:00Z'),
  now: new Date('2026-07-15T11:00:00Z'),
};
const next = (i: Omit<TransitionInput, 'startAt' | 'endAt' | 'now'> & Partial<TransitionInput>) => nextCampaignStatus({ ...base, ...i });

test('happy path: draft → submitted → under review → active', () => {
  assert.equal(next({ action: 'SUBMIT', actor: 'OWNER', current: 'DRAFT' }), 'SUBMITTED');
  assert.equal(next({ action: 'START_REVIEW', actor: 'SILVA', current: 'SUBMITTED' }), 'UNDER_REVIEW');
  assert.equal(next({ action: 'APPROVE', actor: 'SILVA', current: 'UNDER_REVIEW' }), 'ACTIVE');
});

test('approval before the start date schedules the campaign', () => {
  assert.equal(next({ action: 'APPROVE', actor: 'SILVA', current: 'SUBMITTED', now: new Date('2026-07-01T00:00:00Z') }), 'SCHEDULED');
});

test('businesses cannot approve their own campaigns; staff cannot submit', () => {
  assert.throws(
    () => next({ action: 'APPROVE', actor: 'OWNER', current: 'SUBMITTED' }),
    (e: WorkflowError) => e.code === 'FORBIDDEN',
  );
  assert.throws(
    () => next({ action: 'SUBMIT', actor: 'STAFF', current: 'DRAFT' }),
    (e: WorkflowError) => e.code === 'FORBIDDEN',
  );
});

test('rejection and change requests need a reason', () => {
  assert.throws(
    () => next({ action: 'REJECT', actor: 'SILVA', current: 'UNDER_REVIEW' }),
    (e: WorkflowError) => e.code === 'REASON_REQUIRED',
  );
  assert.equal(next({ action: 'REJECT', actor: 'SILVA', current: 'UNDER_REVIEW', reason: 'Unlicensed music' }), 'REJECTED');
  assert.equal(next({ action: 'REQUEST_CHANGES', actor: 'SILVA', current: 'SUBMITTED', reason: 'Logo is cropped' }), 'CHANGES_REQUESTED');
  assert.equal(next({ action: 'SUBMIT', actor: 'OWNER', current: 'CHANGES_REQUESTED' }), 'SUBMITTED');
});

test('pause and resume', () => {
  assert.equal(next({ action: 'PAUSE', actor: 'OWNER', current: 'ACTIVE' }), 'PAUSED');
  assert.equal(next({ action: 'RESUME', actor: 'SILVA', current: 'PAUSED' }), 'ACTIVE');
  assert.equal(next({ action: 'RESUME', actor: 'OWNER', current: 'PAUSED', now: new Date('2026-08-01T00:00:00Z') }), 'COMPLETED');
});

test('invalid transitions are refused', () => {
  assert.throws(
    () => next({ action: 'APPROVE', actor: 'SILVA', current: 'DRAFT' }),
    (e: WorkflowError) => e.code === 'INVALID_TRANSITION',
  );
  assert.throws(
    () => next({ action: 'PAUSE', actor: 'SILVA', current: 'REJECTED' }),
    (e: WorkflowError) => e.code === 'INVALID_TRANSITION',
  );
  assert.throws(
    () => next({ action: 'CANCEL', actor: 'SILVA', current: 'COMPLETED' }),
    (e: WorkflowError) => e.code === 'INVALID_TRANSITION',
  );
});

test('ended campaigns cannot be submitted or approved', () => {
  const late = new Date('2026-08-01T00:00:00Z');
  assert.throws(
    () => next({ action: 'SUBMIT', actor: 'OWNER', current: 'DRAFT', now: late }),
    (e: WorkflowError) => e.code === 'CAMPAIGN_ENDED',
  );
  assert.throws(
    () => next({ action: 'APPROVE', actor: 'SILVA', current: 'SUBMITTED', now: late }),
    (e: WorkflowError) => e.code === 'CAMPAIGN_ENDED',
  );
});

test('system tick advances scheduled → active → completed', () => {
  assert.equal(next({ action: 'SYSTEM_TICK', actor: 'SILVA', current: 'SCHEDULED' }), 'ACTIVE');
  assert.equal(next({ action: 'SYSTEM_TICK', actor: 'SILVA', current: 'ACTIVE', now: new Date('2026-08-01T00:00:00Z') }), 'COMPLETED');
  assert.equal(next({ action: 'SYSTEM_TICK', actor: 'SILVA', current: 'DRAFT' }), 'DRAFT');
});
