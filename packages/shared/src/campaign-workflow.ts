import type { CampaignStatus } from './engine/types.js';

/**
 * Campaign lifecycle:
 *   DRAFT → SUBMITTED → UNDER_REVIEW → APPROVED → SCHEDULED → ACTIVE → COMPLETED
 *                                   ↘ REJECTED
 *                                   ↘ CHANGES_REQUESTED → (edit) → SUBMITTED
 *   SCHEDULED/ACTIVE ⇄ PAUSED; most states → CANCELLED.
 * APPROVED is transient: approval immediately resolves to SCHEDULED, ACTIVE,
 * or (if the end date has passed) is refused.
 */
export type CampaignAction =
  | 'SUBMIT'
  | 'START_REVIEW'
  | 'APPROVE'
  | 'REJECT'
  | 'REQUEST_CHANGES'
  | 'PAUSE'
  | 'RESUME'
  | 'CANCEL'
  | 'SYSTEM_TICK';

export type ActorKind = 'OWNER' | 'STAFF' | 'SILVA';

export class WorkflowError extends Error {
  constructor(
    message: string,
    readonly code: 'FORBIDDEN' | 'INVALID_TRANSITION' | 'REASON_REQUIRED' | 'CAMPAIGN_ENDED',
  ) {
    super(message);
  }
}

const EDITABLE: CampaignStatus[] = ['DRAFT', 'CHANGES_REQUESTED'];
export const isEditable = (s: CampaignStatus) => EDITABLE.includes(s);

/** Statuses counted against max_active_campaigns. */
export const COUNTS_AGAINST_QUOTA: CampaignStatus[] = ['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'SCHEDULED', 'ACTIVE', 'PAUSED'];

export function timeDerivedStatus(startAt: Date, endAt: Date, now: Date): 'SCHEDULED' | 'ACTIVE' | 'COMPLETED' {
  if (now >= endAt) return 'COMPLETED';
  return now < startAt ? 'SCHEDULED' : 'ACTIVE';
}

const RULES: Record<Exclude<CampaignAction, 'SYSTEM_TICK'>, { from: CampaignStatus[]; actors: ActorKind[]; needsReason?: boolean }> = {
  SUBMIT: { from: ['DRAFT', 'CHANGES_REQUESTED'], actors: ['OWNER'] },
  START_REVIEW: { from: ['SUBMITTED'], actors: ['SILVA'] },
  APPROVE: { from: ['SUBMITTED', 'UNDER_REVIEW'], actors: ['SILVA'] },
  REJECT: { from: ['SUBMITTED', 'UNDER_REVIEW'], actors: ['SILVA'], needsReason: true },
  REQUEST_CHANGES: { from: ['SUBMITTED', 'UNDER_REVIEW'], actors: ['SILVA'], needsReason: true },
  PAUSE: { from: ['SCHEDULED', 'ACTIVE'], actors: ['OWNER', 'SILVA'] },
  RESUME: { from: ['PAUSED'], actors: ['OWNER', 'SILVA'] },
  CANCEL: {
    from: ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'CHANGES_REQUESTED', 'SCHEDULED', 'ACTIVE', 'PAUSED'],
    actors: ['OWNER', 'SILVA'],
  },
};

export interface TransitionInput {
  action: CampaignAction;
  actor: ActorKind;
  current: CampaignStatus;
  startAt: Date;
  endAt: Date;
  now: Date;
  reason?: string | null;
}

/** Returns the next status or throws a WorkflowError. Pure; the API persists the result. */
export function nextCampaignStatus(input: TransitionInput): CampaignStatus {
  const { action, actor, current, startAt, endAt, now } = input;

  if (action === 'SYSTEM_TICK') {
    if (current === 'SCHEDULED' || current === 'ACTIVE') return timeDerivedStatus(startAt, endAt, now);
    if (current === 'PAUSED' && now >= endAt) return 'COMPLETED';
    return current;
  }

  const rule = RULES[action];
  if (!rule.actors.includes(actor)) throw new WorkflowError(`${actor} may not ${action}`, 'FORBIDDEN');
  if (!rule.from.includes(current)) throw new WorkflowError(`Cannot ${action} a campaign that is ${current}`, 'INVALID_TRANSITION');
  if (rule.needsReason && !input.reason?.trim()) throw new WorkflowError(`${action} requires a reason`, 'REASON_REQUIRED');

  switch (action) {
    case 'SUBMIT':
      if (now >= endAt) throw new WorkflowError('Campaign end date has already passed', 'CAMPAIGN_ENDED');
      return 'SUBMITTED';
    case 'START_REVIEW':
      return 'UNDER_REVIEW';
    case 'APPROVE': {
      const s = timeDerivedStatus(startAt, endAt, now);
      if (s === 'COMPLETED') throw new WorkflowError('Campaign end date has already passed', 'CAMPAIGN_ENDED');
      return s;
    }
    case 'REJECT':
      return 'REJECTED';
    case 'REQUEST_CHANGES':
      return 'CHANGES_REQUESTED';
    case 'PAUSE':
      return 'PAUSED';
    case 'RESUME':
      return timeDerivedStatus(startAt, endAt, now);
    case 'CANCEL':
      return 'CANCELLED';
  }
}
