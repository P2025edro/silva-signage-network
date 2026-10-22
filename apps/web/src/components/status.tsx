import { Badge, type Tone } from './ui';

const CAMPAIGN: Record<string, [Tone, string]> = {
  DRAFT: ['neutral', 'Draft'],
  SUBMITTED: ['info', 'Submitted'],
  UNDER_REVIEW: ['info', 'Under review'],
  CHANGES_REQUESTED: ['warn', 'Changes requested'],
  APPROVED: ['ok', 'Approved'],
  REJECTED: ['bad', 'Rejected'],
  SCHEDULED: ['accent', 'Scheduled'],
  ACTIVE: ['ok', 'Active'],
  PAUSED: ['warn', 'Paused'],
  COMPLETED: ['neutral', 'Completed'],
  CANCELLED: ['neutral', 'Cancelled'],
};
export const CampaignStatus = ({ status }: { status: string }) => {
  const [tone, label] = CAMPAIGN[status] ?? ['neutral', status];
  return <Badge tone={tone}>{label}</Badge>;
};

const HEALTH: Record<string, [Tone, string]> = {
  PLAYING: ['ok', 'Playback active'],
  ONLINE: ['ok', 'Online'],
  SYNC_PENDING: ['info', 'Sync pending'],
  STALLED: ['warn', 'Playback stalled'],
  ERROR: ['bad', 'Error detected'],
  OFFLINE: ['bad', 'Offline'],
  NEVER_CONNECTED: ['neutral', 'Not connected yet'],
  DISABLED: ['neutral', 'Disabled'],
};
export const ScreenHealth = ({ health }: { health: string }) => {
  const [tone, label] = HEALTH[health] ?? ['neutral', health];
  return (
    <Badge tone={tone} dot>
      {label}
    </Badge>
  );
};

const SUB: Record<string, Tone> = { ACTIVE: 'ok', TRIALING: 'info', PAST_DUE: 'warn', INCOMPLETE: 'warn', CANCELED: 'neutral', UNPAID: 'bad' };
export const SubscriptionStatus = ({ status, source }: { status: string | null | undefined; source?: string }) =>
  status ? (
    <span className="inline-flex items-center gap-1.5">
      <Badge tone={SUB[status] ?? 'neutral'}>{status.charAt(0) + status.slice(1).toLowerCase().replace('_', ' ')}</Badge>
      {source === 'MANUAL' && <Badge tone="neutral">Manual</Badge>}
    </span>
  ) : (
    <Badge>None</Badge>
  );

export const DevFixture = () => (
  <Badge tone="warn" className="uppercase tracking-wide">
    Dev fixture
  </Badge>
);

export const REASON_LABELS: Record<string, string> = {
  SCREEN_NOT_ACTIVE: 'Screen disabled',
  HOST_SUSPENDED: 'Host account suspended',
  HOST_SUBSCRIPTION_INACTIVE: 'Host has no active subscription',
  LOCATION_NOT_PARTICIPATING: 'Location opted out of network ads',
  LOCATION_CLOSED: 'Outside opening hours',
  CAMPAIGN_NOT_APPROVED: 'Not approved',
  BEFORE_START: 'Not started yet',
  AFTER_END: 'Ended',
  OUTSIDE_SCHEDULE: 'Outside its schedule',
  ADVERTISER_SUSPENDED: 'Advertiser suspended',
  SUBSCRIPTION_INACTIVE: 'Advertiser subscription inactive',
  QUOTA_EXHAUSTED: 'Monthly playback allocation used',
  OWN_SCREEN: "Advertiser's own screen",
  ZONE_MISMATCH: 'Outside target zones',
  VENUE_CATEGORY_NOT_TARGETED: 'Venue type not targeted',
  VENUE_CATEGORY_EXCLUDED: 'Venue type excluded by advertiser',
  ADVERTISER_EXCLUDED_BY_HOST: 'Host excluded this advertiser',
  CATEGORY_BLOCKED_BY_HOST: 'Host blocks this category',
  CATEGORY_NOT_ALLOWED_BY_HOST: 'Host does not allow this category',
  NO_COMPATIBLE_MEDIA: 'No media this screen can play',
};
