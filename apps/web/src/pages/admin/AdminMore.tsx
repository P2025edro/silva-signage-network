import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Download, Info, Layers, Megaphone, Plus, RefreshCw, XCircle } from 'lucide-react';
import { api, apiUrl, errorMessage } from '@/lib/api';
import { isSuperAdmin, useMe } from '@/lib/auth';
import { DAYS, fmtDate, fmtDateTime, fmtEuro, fmtNumber, fmtRelative, minutesToHHMM } from '@/lib/format';
import { ENTITLEMENT_LABELS, type CampaignDetail, type CampaignRow, type Paged, type Plan } from '@/lib/types';
import { BarChart, BarList } from '@/components/charts';
import { MediaThumb, PlaylistPanel, useCategories, useZones } from '@/components/features';
import { CampaignStatus, DevFixture, REASON_LABELS, SubscriptionStatus } from '@/components/status';
import { useToast } from '@/components/toast';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Notice,
  PageHeader,
  Pagination,
  Select,
  Spinner,
  Stat,
  Table,
  Tabs,
  Td,
  Textarea,
  Th,
} from '@/components/ui';
import { SecurityCard } from '../portal/PortalPages';

// ---- Campaign queue -------------------------------------------------------------------------
const QUEUES = {
  review: 'SUBMITTED,UNDER_REVIEW',
  live: 'SCHEDULED,ACTIVE,PAUSED',
  changes: 'CHANGES_REQUESTED,DRAFT',
  done: 'COMPLETED,CANCELLED,REJECTED',
} as const;

export function AdminCampaigns() {
  const [tab, setTab] = useState<keyof typeof QUEUES>('review');
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['admin', 'campaigns', tab, page],
    queryFn: () => api.get<Paged<CampaignRow>>(`/api/admin/campaigns?status=${QUEUES[tab]}&page=${page}&pageSize=25`),
  });
  return (
    <>
      <PageHeader title="Campaigns" description="Every advert is reviewed by Silva Solutions before it reaches the network." />
      <Tabs
        value={tab}
        onChange={(t) => {
          setTab(t);
          setPage(1);
        }}
        tabs={[
          { value: 'review', label: 'Awaiting review' },
          { value: 'live', label: 'Live' },
          { value: 'changes', label: 'With advertiser' },
          { value: 'done', label: 'Finished' },
        ]}
      />
      <Card padded={false}>
        {q.isLoading ? (
          <Spinner />
        ) : q.error ? (
          <ErrorState error={q.error} />
        ) : !q.data?.items.length ? (
          <EmptyState icon={<Megaphone className="size-6" />} title={tab === 'review' ? 'Review queue is clear' : 'Nothing here'} />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th>Campaign</Th>
                  <Th>Advertiser</Th>
                  <Th>Status</Th>
                  <Th>Runs</Th>
                  <Th>Submitted</Th>
                  <Th className="text-right">Plays</Th>
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((c) => (
                  <tr key={c.id} className="hover:bg-subtle/50">
                    <Td>
                      <Link to={`/admin/campaigns/${c.id}`} className="font-medium hover:underline">
                        {c.name}
                      </Link>
                    </Td>
                    <Td>
                      {c.companyName} {c.isDevFixture && <DevFixture />}
                    </Td>
                    <Td>
                      <CampaignStatus status={c.status} />
                    </Td>
                    <Td className="text-muted">
                      {fmtDate(c.startAt)} – {fmtDate(c.endAt)}
                    </Td>
                    <Td className="text-muted">{fmtRelative(c.submittedAt)}</Td>
                    <Td className="tabular text-right">{fmtNumber(c.playbackStarts)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={page} pageSize={25} total={q.data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}

export function AdminCampaignReview() {
  const { campaignId } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const { data: zones } = useZones();
  const { data: categories } = useCategories();
  const {
    data: c,
    isLoading,
    error,
  } = useQuery({ queryKey: ['admin', 'campaign', campaignId], queryFn: () => api.get<CampaignDetail>(`/api/admin/campaigns/${campaignId}`) });
  const [reasonFor, setReasonFor] = useState<'REJECT' | 'REQUEST_CHANGES' | 'PAUSE' | 'CANCEL' | null>(null);
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<CampaignDetail['media'][number] | null>(null);
  const act = useMutation({
    mutationFn: ({ action, reason }: { action: string; reason?: string }) =>
      api.post<{ status: string }>(`/api/companies/${c!.companyId}/campaigns/${campaignId}/actions`, { action, reason }),
    onSuccess: (r) => {
      setReasonFor(null);
      setReason('');
      qc.invalidateQueries({ queryKey: ['admin'] });
      toast.ok(`Campaign is now ${r.status.toLowerCase().replace('_', ' ')}`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const priority = useMutation({
    mutationFn: (p: number) => api.post(`/api/admin/campaigns/${campaignId}/priority`, { priority: p }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'campaign', campaignId] });
      toast.ok('Priority updated');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (isLoading) return <Spinner />;
  if (error || !c) return <ErrorState error={error} />;
  const name = (ids: string[], list?: Array<{ id: string; name: string }>) =>
    ids.length ? ids.map((id) => list?.find((x) => x.id === id)?.name ?? id).join(', ') : 'Any';
  const reviewable = ['SUBMITTED', 'UNDER_REVIEW'].includes(c.status);
  return (
    <>
      <Link to="/admin/campaigns" className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" /> Campaigns
      </Link>
      <PageHeader
        title={c.name}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <CampaignStatus status={c.status} />
            <Link to={`/admin/companies/${c.companyId}`} className="hover:underline">
              {c.companyName}
            </Link>
            {c.isDevFixture && <DevFixture />}
          </span>
        }
        actions={
          <>
            {c.status === 'SUBMITTED' && (
              <Button variant="outline" onClick={() => act.mutate({ action: 'START_REVIEW' })}>
                Start review
              </Button>
            )}
            {reviewable && (
              <>
                <Button variant="outline" onClick={() => setReasonFor('REQUEST_CHANGES')}>
                  Request changes
                </Button>
                <Button variant="danger" onClick={() => setReasonFor('REJECT')}>
                  Reject
                </Button>
                <Button onClick={() => act.mutate({ action: 'APPROVE' })} loading={act.isPending}>
                  Approve
                </Button>
              </>
            )}
            {['SCHEDULED', 'ACTIVE'].includes(c.status) && (
              <Button variant="outline" onClick={() => setReasonFor('PAUSE')}>
                Pause
              </Button>
            )}
            {c.status === 'PAUSED' && <Button onClick={() => act.mutate({ action: 'RESUME' })}>Resume</Button>}
            {['SUBMITTED', 'UNDER_REVIEW', 'SCHEDULED', 'ACTIVE', 'PAUSED', 'CHANGES_REQUESTED', 'DRAFT'].includes(c.status) && (
              <Button variant="ghost" className="text-bad" onClick={() => setReasonFor('CANCEL')}>
                Cancel
              </Button>
            )}
          </>
        }
      />
      {reviewable && (
        <div className="mb-6">
          <Notice title="Review checklist">
            Check the advertiser has rights to all images, music and logos; claims are accurate; content suits all ages and the venues targeted; and it follows
            the ASAI Code. Approving makes it eligible for distribution immediately.
          </Notice>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Creatives" className="lg:col-span-2">
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {c.media.map((m) => (
              <li key={m.id}>
                <button onClick={() => setPreview(m)} className="block w-full text-left">
                  <MediaThumb m={m} className="aspect-video w-full" />
                </button>
                <div className="mt-1 text-xs text-muted">
                  {m.kind === 'VIDEO' ? `Video · ${((m.durationMs ?? 0) / 1000).toFixed(0)}s · ${m.videoCodec}` : `Image · ${m.displaySeconds}s`} · {m.width}×
                  {m.height}
                </div>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Details">
          <dl className="space-y-2 text-sm">
            {(
              [
                ['Runs', `${fmtDateTime(c.startAt)} – ${fmtDateTime(c.endAt)}`],
                [
                  'Schedule',
                  c.schedule
                    ? `${c.schedule.days.map((d) => DAYS[d - 1]).join(', ')} · ${minutesToHHMM(c.schedule.startMinute)}–${minutesToHHMM(c.schedule.endMinute)}`
                    : 'Any time venues are open',
                ],
                ['Zones', name(c.targetZoneIds, zones)],
                ['Venue types', name(c.targetCategoryIds, categories)],
                ['Excluded venues', c.excludedCategoryIds.length ? name(c.excludedCategoryIds, categories) : 'None'],
                ['Requested plays/day', c.requestedPlaysPerDay ? fmtNumber(c.requestedPlaysPerDay) : '—'],
              ] as const
            ).map(([k, v]) => (
              <div key={k}>
                <dt className="text-xs text-muted">{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
            <div>
              <dt className="text-xs text-muted">Priority (Silva only)</dt>
              <dd>
                <Select aria-label="Priority" value={c.priority} onChange={(e) => priority.mutate(Number(e.target.value))} className="mt-1 w-32">
                  {[1, 2, 3, 4, 5].map((p) => (
                    <option key={p} value={p}>
                      {p} {p === 3 ? '(normal)' : p === 5 ? '(highest)' : p === 1 ? '(lowest)' : ''}
                    </option>
                  ))}
                </Select>
              </dd>
            </div>
            {c.description && (
              <div>
                <dt className="text-xs text-muted">Description</dt>
                <dd className="text-muted">{c.description}</dd>
              </div>
            )}
          </dl>
        </Card>
      </div>
      {c.capacity && (
        <div className="mt-6 grid gap-6 lg:grid-cols-3">
          <Card title="Current distribution" className="lg:col-span-2" padded={false}>
            {c.capacity.screens.length ? (
              <Table>
                <thead>
                  <tr>
                    <Th>Screen</Th>
                    <Th className="text-right">Slots in loop</Th>
                    <Th className="text-right">Loop length</Th>
                    <Th className="text-right">Est. plays today</Th>
                  </tr>
                </thead>
                <tbody>
                  {c.capacity.screens.map((s) => (
                    <tr key={s.screenId}>
                      <Td>
                        {s.screenName} <span className="text-muted">· {s.locationName}</span>
                      </Td>
                      <Td className="tabular text-right">{s.slotsPerLoop}</Td>
                      <Td className="tabular text-right">{s.loopSeconds}s</Td>
                      <Td className="tabular text-right">{fmtNumber(s.estimatedPlaysToday)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <p className="p-5 text-sm text-muted">Not on any screen right now.</p>
            )}
          </Card>
          <Card title="Capacity">
            <Stat label="Estimated plays/day" value={fmtNumber(c.capacity.estimatedPerDay)} />
            {c.capacity.shortfallPerDay > 0 && (
              <div className="mt-3">
                <Notice tone="warn">Short by about {fmtNumber(c.capacity.shortfallPerDay)} plays/day against the request.</Notice>
              </div>
            )}
          </Card>
        </div>
      )}
      <div className="mt-6">
        <Card title="Review history">
          {c.reviews.length ? (
            <ol className="space-y-2 text-sm">
              {c.reviews.map((r, i) => (
                <li key={i} className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted">{fmtDateTime(r.createdAt)}</span>
                  <CampaignStatus status={r.toStatus} />
                  <span className="text-muted">by {r.byName}</span>
                  {r.reason && <span className="text-muted">— “{r.reason}”</span>}
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-muted">No history yet.</p>
          )}
        </Card>
      </div>
      <Dialog
        open={reasonFor !== null}
        onClose={() => setReasonFor(null)}
        title={{ REJECT: 'Reject campaign', REQUEST_CHANGES: 'Request changes', PAUSE: 'Pause campaign', CANCEL: 'Cancel campaign' }[reasonFor ?? 'REJECT']}
        description="The advertiser sees this message."
        footer={
          <Button
            variant={reasonFor === 'REJECT' || reasonFor === 'CANCEL' ? 'danger' : 'primary'}
            disabled={(reasonFor === 'REJECT' || reasonFor === 'REQUEST_CHANGES') && reason.trim().length < 3}
            loading={act.isPending}
            onClick={() => act.mutate({ action: reasonFor!, reason: reason || undefined })}
          >
            Confirm
          </Button>
        }
      >
        <Field label={reasonFor === 'REJECT' || reasonFor === 'REQUEST_CHANGES' ? 'Reason (required)' : 'Note (optional)'} htmlFor="reason">
          <Textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </Dialog>
      <Dialog open={preview !== null} onClose={() => setPreview(null)} wide title={preview?.originalFilename ?? ''}>
        {preview &&
          (preview.kind === 'VIDEO' ? (
            <video src={preview.previewUrl} controls className="w-full rounded bg-black" />
          ) : (
            <img src={preview.previewUrl} alt={preview.originalFilename} className="w-full rounded" />
          ))}
      </Dialog>
    </>
  );
}

// ---- Network -----------------------------------------------------------------------------
export function AdminNetwork() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ['admin', 'network'],
    queryFn: () =>
      api.get<
        Array<{
          screenId: string;
          screenName: string;
          locationName: string;
          hostName: string;
          version: number | null;
          validUntil: string | null;
          itemCount: number;
          advertiserCount: number;
          screenReasons: string[] | null;
        }>
      >('/api/admin/network/summary'),
  });
  const settings = useQuery({ queryKey: ['admin', 'settings'], queryFn: () => api.get<Array<{ key: string; value: unknown }>>('/api/admin/settings') });
  const [selected, setSelected] = useState<string | null>(null);
  const regen = useMutation({
    mutationFn: () => api.post<{ screens: number; changed: number }>('/api/admin/network/regenerate'),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['admin', 'network'] });
      toast.ok(`Regenerated ${r.screens} playlists (${r.changed} changed)`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const s = Object.fromEntries((settings.data ?? []).map((x) => [x.key, x.value]));
  const sel = q.data?.find((x) => x.screenId === selected);
  return (
    <>
      <PageHeader
        title="Advertising network"
        description="Each screen gets its own playlist, generated from eligible approved campaigns. Playlists refresh every 15 minutes and whenever a campaign, rule or subscription changes."
        actions={
          <Button variant="outline" onClick={() => regen.mutate()} loading={regen.isPending}>
            <RefreshCw className="size-4" /> Regenerate all
          </Button>
        }
      />
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Slots per loop" value={String(s['distribution.slots_per_loop'] ?? '—')} />
        <Stat
          label="Max share per advertiser"
          value={s['distribution.max_advertiser_share'] ? `${Math.round(Number(s['distribution.max_advertiser_share']) * 100)}%` : '—'}
          sub="when others are eligible"
        />
        <Stat label="Own screens" value={s['distribution.allow_own_screens'] ? 'Included' : 'Excluded'} sub="for an advertiser's own ads" />
        <Stat label="Host subscription" value={s['distribution.require_host_subscription'] ? 'Required' : 'Not required'} />
      </div>
      <Card padded={false}>
        {q.isLoading ? (
          <Spinner />
        ) : !q.data?.length ? (
          <EmptyState icon={<Layers className="size-6" />} title="No screens in the network yet" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Screen</Th>
                <Th>Host</Th>
                <Th className="text-right">Items in loop</Th>
                <Th className="text-right">Advertisers</Th>
                <Th>Version</Th>
                <Th>Notes</Th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((r) => (
                <tr key={r.screenId} className="cursor-pointer hover:bg-subtle/50" onClick={() => setSelected(r.screenId)}>
                  <Td>
                    <div className="font-medium">{r.screenName}</div>
                    <div className="text-xs text-muted">{r.locationName}</div>
                  </Td>
                  <Td>{r.hostName}</Td>
                  <Td className="tabular text-right">{r.itemCount}</Td>
                  <Td className="tabular text-right">{r.advertiserCount}</Td>
                  <Td className="tabular text-xs text-muted">{r.version ? `v${r.version}` : '—'}</Td>
                  <Td className="text-xs text-muted">
                    {r.screenReasons?.length ? r.screenReasons.map((x) => REASON_LABELS[x] ?? x).join(' · ') : r.itemCount === 0 ? 'No eligible campaigns' : ''}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Dialog
        open={selected !== null}
        onClose={() => setSelected(null)}
        wide
        title={sel?.screenName ?? ''}
        description={sel ? `${sel.locationName} · ${sel.hostName}` : ''}
      >
        {selected && <PlaylistPanel url={`/api/admin/network/screens/${selected}/playlist`} />}
      </Dialog>
    </>
  );
}

// ---- Zones --------------------------------------------------------------------------------
export function AdminZones() {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ['admin', 'zones'],
    queryFn: () => api.get<Array<{ id: string; name: string; city: string; active: boolean; locations: number; screens: number }>>('/api/admin/zones'),
  });
  const [editing, setEditing] = useState<{ id?: string; name: string; city: string; active: boolean } | null>(null);
  const save = useMutation({
    mutationFn: () => (editing!.id ? api.put(`/api/admin/zones/${editing!.id}`, editing) : api.post('/api/admin/zones', editing)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'zones'] });
      qc.invalidateQueries({ queryKey: ['zones'] });
      setEditing(null);
      toast.ok('Zone saved');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <>
      <PageHeader
        title="Geographic zones"
        description="Areas advertisers can target. Zones are configuration — a zone existing doesn't mean screens are installed there."
        actions={
          isSuperAdmin(me) && (
            <Button onClick={() => setEditing({ name: '', city: 'Dublin', active: true })}>
              <Plus className="size-4" /> New zone
            </Button>
          )
        }
      />
      <Card padded={false}>
        {q.isLoading ? (
          <Spinner />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Zone</Th>
                <Th>City</Th>
                <Th className="text-right">Establishments</Th>
                <Th className="text-right">Screens</Th>
                <Th>Status</Th>
                {isSuperAdmin(me) && <Th />}
              </tr>
            </thead>
            <tbody>
              {q.data?.map((z) => (
                <tr key={z.id}>
                  <Td className="font-medium">{z.name}</Td>
                  <Td>{z.city}</Td>
                  <Td className="tabular text-right">{z.locations}</Td>
                  <Td className="tabular text-right">{z.screens}</Td>
                  <Td>{z.active ? <Badge tone="ok">Active</Badge> : <Badge>Inactive</Badge>}</Td>
                  {isSuperAdmin(me) && (
                    <Td className="text-right">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(z)}>
                        Edit
                      </Button>
                    </Td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing?.id ? 'Edit zone' : 'New zone'}
        footer={
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            Save
          </Button>
        }
      >
        {editing && (
          <div className="space-y-4">
            <Field label="Name" htmlFor="z-name">
              <Input id="z-name" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </Field>
            <Field label="City" htmlFor="z-city">
              <Input id="z-city" value={editing.city} onChange={(e) => setEditing({ ...editing, city: e.target.value })} />
            </Field>
            <Checkbox label="Active (available for targeting)" checked={editing.active} onChange={(v) => setEditing({ ...editing, active: v })} />
          </div>
        )}
      </Dialog>
    </>
  );
}

// ---- Subscriptions & plans -------------------------------------------------------------------
export function AdminSubscriptions() {
  const qc = useQueryClient();
  const toast = useToast();
  const subs = useQuery({
    queryKey: ['admin', 'subscriptions'],
    queryFn: () =>
      api.get<
        Array<{
          id: string;
          companyId: string;
          companyName: string;
          isDevFixture: boolean;
          planName: string;
          status: string;
          source: string;
          currentPeriodStart: string;
          currentPeriodEnd: string;
          note: string | null;
        }>
      >('/api/admin/subscriptions'),
  });
  const plans = useQuery({ queryKey: ['plans'], queryFn: () => api.get<Plan[]>('/api/plans') });
  const [editing, setEditing] = useState<Plan | null>(null);
  const cancel = useMutation({
    mutationFn: (id: string) => api.post(`/api/admin/subscriptions/${id}/cancel`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'subscriptions'] });
      toast.ok('Subscription cancelled');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const savePlan = useMutation({
    mutationFn: () =>
      api.put(`/api/admin/plans/${editing!.id}`, {
        name: editing!.name,
        monthlyPriceCents: editing!.monthlyPriceCents,
        priceIsDraft: editing!.priceIsDraft,
        stripePriceId: editing!.stripePriceId || null,
        active: true,
        entitlements: editing!.entitlements,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['plans'] });
      setEditing(null);
      toast.ok('Plan updated. Playlists regenerated with the new entitlements.');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <>
      <PageHeader title="Subscriptions" description="Plans, entitlements and every company's subscription." />
      <Card title="Plans" padded={false}>
        <Table>
          <thead>
            <tr>
              <Th>Plan</Th>
              <Th className="text-right">Price / month</Th>
              {Object.keys(ENTITLEMENT_LABELS).map((k) => (
                <Th key={k} className="text-right">
                  {ENTITLEMENT_LABELS[k]}
                </Th>
              ))}
              <Th />
            </tr>
          </thead>
          <tbody>
            {plans.data?.map((p) => (
              <tr key={p.id}>
                <Td className="font-medium">
                  {p.name} {p.priceIsDraft && <Badge tone="warn">Draft price</Badge>} {p.onlineCheckout && <Badge tone="info">Stripe</Badge>}
                </Td>
                <Td className="tabular text-right">{fmtEuro(p.monthlyPriceCents)}</Td>
                {Object.keys(ENTITLEMENT_LABELS).map((k) => (
                  <Td key={k} className="tabular text-right">
                    {fmtNumber(p.entitlements[k])}
                  </Td>
                ))}
                <Td className="text-right">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>
                    Edit
                  </Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <p className="border-t border-line px-5 py-3 text-xs text-muted">
          Prices marked “draft” are development examples, not approved commercial pricing. VAT treatment must be confirmed with an accountant before billing.
        </p>
      </Card>
      <div className="mt-6">
        <Card title="Company subscriptions" padded={false}>
          {subs.isLoading ? (
            <Spinner />
          ) : !subs.data?.length ? (
            <p className="p-5 text-sm text-muted">No subscriptions.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Company</Th>
                  <Th>Plan</Th>
                  <Th>Status</Th>
                  <Th>Period</Th>
                  <Th>Note</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {subs.data.map((s) => (
                  <tr key={s.id}>
                    <Td>
                      <Link to={`/admin/companies/${s.companyId}`} className="hover:underline">
                        {s.companyName}
                      </Link>{' '}
                      {s.isDevFixture && <DevFixture />}
                    </Td>
                    <Td>{s.planName}</Td>
                    <Td>
                      <SubscriptionStatus status={s.status} source={s.source} />
                    </Td>
                    <Td className="text-muted">
                      {fmtDate(s.currentPeriodStart)} – {fmtDate(s.currentPeriodEnd)}
                    </Td>
                    <Td className="max-w-56 truncate text-xs text-muted" title={s.note ?? ''}>
                      {s.note}
                    </Td>
                    <Td className="text-right">
                      {s.source === 'MANUAL' && ['ACTIVE', 'TRIALING'].includes(s.status) && (
                        <Button size="sm" variant="ghost" className="text-bad" onClick={() => cancel.mutate(s.id)}>
                          Cancel
                        </Button>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        wide
        title={`Edit plan — ${editing?.name ?? ''}`}
        footer={
          <Button onClick={() => savePlan.mutate()} loading={savePlan.isPending}>
            Save plan
          </Button>
        }
      >
        {editing && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="p-name">
              <Input id="p-name" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </Field>
            <Field label="Monthly price (cents)" htmlFor="p-price">
              <Input
                id="p-price"
                type="number"
                min={0}
                value={editing.monthlyPriceCents}
                onChange={(e) => setEditing({ ...editing, monthlyPriceCents: Number(e.target.value) })}
              />
            </Field>
            <Field label="Stripe price ID" htmlFor="p-stripe" hint="Leave blank until the plan exists in Stripe.">
              <Input
                id="p-stripe"
                value={editing.stripePriceId ?? ''}
                onChange={(e) => setEditing({ ...editing, stripePriceId: e.target.value })}
                placeholder="price_…"
              />
            </Field>
            <div className="flex items-end">
              <Checkbox label="Price is a draft (not approved)" checked={editing.priceIsDraft} onChange={(v) => setEditing({ ...editing, priceIsDraft: v })} />
            </div>
            {Object.keys(ENTITLEMENT_LABELS).map((k) => (
              <Field key={k} label={ENTITLEMENT_LABELS[k]!} htmlFor={`p-${k}`}>
                <Input
                  id={`p-${k}`}
                  type="number"
                  min={0}
                  value={editing.entitlements[k] ?? 0}
                  onChange={(e) => setEditing({ ...editing, entitlements: { ...editing.entitlements, [k]: Number(e.target.value) } })}
                />
              </Field>
            ))}
          </div>
        )}
      </Dialog>
    </>
  );
}

export function AdminBilling() {
  const q = useQuery({
    queryKey: ['admin', 'billing'],
    queryFn: () =>
      api.get<{
        stripeConfigured: boolean;
        webhookConfigured: boolean;
        plansMappedToStripe: number;
        events: Array<{
          id: string;
          type: string;
          amountCents: number | null;
          receivedAt: string;
          processedAt: string | null;
          processingError: string | null;
          companyName: string | null;
        }>;
      }>('/api/admin/billing'),
  });
  const a = useQuery({
    queryKey: ['admin', 'analytics', 'billing'],
    queryFn: () =>
      api.get<{
        billing: {
          activePaying: number;
          cancellations: number;
          failedPayments: number;
          paidCents: number;
          revenueByPlan: Array<{ plan: string; subscriptions: number; mrrCents: number }>;
        };
      }>('/api/admin/analytics'),
  });
  if (q.isLoading) return <Spinner />;
  const d = q.data!;
  const b = a.data?.billing;
  return (
    <>
      <PageHeader
        title="Billing"
        description="Figures come only from Stripe events whose signatures were verified. Manual (pilot) subscriptions are never counted."
      />
      {(!d.stripeConfigured || !d.webhookConfigured) && (
        <div className="mb-6">
          <Notice tone="warn" title="Stripe is not fully configured">
            {!d.stripeConfigured && 'STRIPE_SECRET_KEY is not set. '}
            {!d.webhookConfigured && 'STRIPE_WEBHOOK_SECRET is not set. '}
            Online checkout and payment tracking are unavailable until both are configured and plans are mapped to Stripe prices ({d.plansMappedToStripe}{' '}
            mapped).
          </Notice>
        </div>
      )}
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Paying subscriptions" value={fmtNumber(b?.activePaying)} />
        <Stat label="Paid (30 days)" value={fmtEuro(b?.paidCents)} />
        <Stat label="Failed payments (30 days)" value={fmtNumber(b?.failedPayments)} tone={b?.failedPayments ? 'warn' : undefined} />
        <Stat label="Cancellations (30 days)" value={fmtNumber(b?.cancellations)} />
      </div>
      <Card title="Provider events" padded={false}>
        {!d.events.length ? (
          <p className="p-5 text-sm text-muted">No billing events received.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Received</Th>
                <Th>Event</Th>
                <Th>Company</Th>
                <Th className="text-right">Amount</Th>
                <Th>Processing</Th>
              </tr>
            </thead>
            <tbody>
              {d.events.map((e) => (
                <tr key={e.id}>
                  <Td className="text-muted">{fmtDateTime(e.receivedAt)}</Td>
                  <Td className="font-mono text-xs">{e.type}</Td>
                  <Td>{e.companyName ?? '—'}</Td>
                  <Td className="tabular text-right">{fmtEuro(e.amountCents)}</Td>
                  <Td>
                    {e.processingError ? (
                      <Badge tone="bad">{e.processingError}</Badge>
                    ) : e.processedAt ? (
                      <Badge tone="ok">Processed</Badge>
                    ) : (
                      <Badge>Pending</Badge>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}

// ---- Analytics -------------------------------------------------------------------------------
export function AdminAnalytics() {
  const { data: zones } = useZones();
  const [days, setDays] = useState(30);
  const [zoneId, setZoneId] = useState('');
  const from = new Date(Date.now() - days * 86_400_000).toISOString();
  const params = `from=${encodeURIComponent(from)}${zoneId ? `&zoneId=${zoneId}` : ''}`;
  const q = useQuery({
    queryKey: ['admin', 'analytics', days, zoneId],
    queryFn: () =>
      api.get<{
        byDay: Array<{ day: string; starts: number; completions: number; failures: number }>;
        byZone: Array<{ zone: string; starts: number }>;
        byCategory: Array<{ category: string; starts: number }>;
        byCampaign: Array<{ id: string; campaign: string; advertiser: string; starts: number; completions: number; failures: number }>;
      }>(`/api/admin/analytics?${params}`),
  });
  return (
    <>
      <PageHeader
        title="Analytics"
        description="Playback events reported by screens. No audience, reach or impression estimates are made."
        actions={
          <>
            <Select aria-label="Period" value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-36">
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={90}>Last 90 days</option>
            </Select>
            <Select aria-label="Zone" value={zoneId} onChange={(e) => setZoneId(e.target.value)} className="w-44">
              <option value="">All zones</option>
              {zones?.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name}
                </option>
              ))}
            </Select>
            <a href={apiUrl(`/api/admin/analytics/playback.csv?${params}`)}>
              <Button variant="outline">
                <Download className="size-4" /> CSV
              </Button>
            </a>
          </>
        }
      />
      {q.isLoading ? (
        <Spinner />
      ) : q.error ? (
        <ErrorState error={q.error} />
      ) : (
        <div className="space-y-6">
          <Card title="Playback by day">
            {q.data!.byDay.length ? (
              <BarChart
                data={q.data!.byDay}
                series={[
                  { key: 'starts', label: 'Starts', className: 'fill-accent' },
                  { key: 'completions', label: 'Completions', className: 'fill-info' },
                  { key: 'failures', label: 'Failures', className: 'fill-bad' },
                ]}
              />
            ) : (
              <p className="py-8 text-center text-sm text-muted">No playback in this period.</p>
            )}
          </Card>
          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="By zone">
              <BarList rows={q.data!.byZone} valueKey="starts" labelKey="zone" />
            </Card>
            <Card title="By venue type">
              <BarList rows={q.data!.byCategory} valueKey="starts" labelKey="category" />
            </Card>
          </div>
          <Card title="By campaign" padded={false}>
            {q.data!.byCampaign.length ? (
              <Table>
                <thead>
                  <tr>
                    <Th>Campaign</Th>
                    <Th>Advertiser</Th>
                    <Th className="text-right">Starts</Th>
                    <Th className="text-right">Completions</Th>
                    <Th className="text-right">Failures</Th>
                  </tr>
                </thead>
                <tbody>
                  {q.data!.byCampaign.map((r) => (
                    <tr key={r.id}>
                      <Td>
                        <Link to={`/admin/campaigns/${r.id}`} className="hover:underline">
                          {r.campaign}
                        </Link>
                      </Td>
                      <Td>{r.advertiser}</Td>
                      <Td className="tabular text-right">{fmtNumber(r.starts)}</Td>
                      <Td className="tabular text-right">{fmtNumber(r.completions)}</Td>
                      <Td className="tabular text-right">{fmtNumber(r.failures)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <p className="p-5 text-sm text-muted">No playback in this period.</p>
            )}
          </Card>
        </div>
      )}
    </>
  );
}

// ---- Alerts ----------------------------------------------------------------------------------
export function AdminAlerts() {
  const q = useQuery({
    queryKey: ['admin', 'alerts'],
    queryFn: () =>
      api.get<Array<{ severity: 'critical' | 'warning' | 'info'; kind: string; message: string; entityType: string; entityId: string; at: string | null }>>(
        '/api/admin/alerts',
      ),
    refetchInterval: 30_000,
  });
  const icon = {
    critical: <XCircle className="size-4 text-bad" />,
    warning: <AlertTriangle className="size-4 text-warn" />,
    info: <Info className="size-4 text-info" />,
  };
  const link = (a: { entityType: string; entityId: string }) =>
    a.entityType === 'campaign'
      ? `/admin/campaigns/${a.entityId}`
      : a.entityType === 'screen'
        ? '/admin/screens'
        : a.entityType === 'billing_event'
          ? '/admin/billing'
          : '#';
  return (
    <>
      <PageHeader title="Alerts" description="Offline or failing screens, overdue reviews, and billing problems. Updates every 30 seconds." />
      <Card padded={false}>
        {q.isLoading ? (
          <Spinner />
        ) : !q.data?.length ? (
          <EmptyState title="All clear">No screens, campaigns or payments need attention.</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {q.data.map((a, i) => (
              <li key={i}>
                <Link to={link(a)} className="flex items-start gap-3 px-5 py-3 hover:bg-subtle/50">
                  <span className="mt-0.5">{icon[a.severity]}</span>
                  <span className="flex-1 text-sm">{a.message}</span>
                  <span className="text-xs whitespace-nowrap text-muted">{fmtRelative(a.at)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

// ---- Audit log -------------------------------------------------------------------------------
export function AdminAudit() {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const q = useQuery({
    queryKey: ['admin', 'audit', page, action],
    queryFn: () =>
      api.get<
        Paged<{
          id: string;
          createdAt: string;
          actorType: string;
          actorEmail: string | null;
          companyName: string | null;
          action: string;
          entityType: string | null;
          metadata: Record<string, unknown>;
          ip: string | null;
        }>
      >(`/api/admin/audit-logs?page=${page}&pageSize=50${action ? `&action=${encodeURIComponent(action)}` : ''}`),
  });
  return (
    <>
      <PageHeader title="Audit logs" description="Append-only record of security-relevant and business-critical actions." />
      <Card padded={false}>
        <div className="border-b border-line p-3">
          <Select
            aria-label="Filter by action"
            value={action}
            onChange={(e) => {
              setAction(e.target.value);
              setPage(1);
            }}
            className="w-56"
          >
            <option value="">All actions</option>
            {['auth.', 'company.', 'location.', 'screen.', 'device.', 'media.', 'campaign.', 'subscription.', 'billing.', 'settings.', 'network.'].map((p) => (
              <option key={p} value={p}>
                {p}*
              </option>
            ))}
          </Select>
        </div>
        {q.isLoading ? (
          <Spinner />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Action</Th>
                  <Th>Actor</Th>
                  <Th>Company</Th>
                  <Th>Details</Th>
                </tr>
              </thead>
              <tbody>
                {q.data?.items.map((r) => (
                  <tr key={r.id}>
                    <Td className="text-xs whitespace-nowrap text-muted">{fmtDateTime(r.createdAt)}</Td>
                    <Td className="font-mono text-xs">{r.action}</Td>
                    <Td className="text-xs">
                      {r.actorEmail ?? r.actorType.toLowerCase()}
                      {r.ip && <div className="text-muted">{r.ip}</div>}
                    </Td>
                    <Td className="text-xs">{r.companyName ?? '—'}</Td>
                    <Td className="max-w-80 truncate font-mono text-[11px] text-muted" title={JSON.stringify(r.metadata)}>
                      {Object.keys(r.metadata ?? {}).length ? JSON.stringify(r.metadata) : ''}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {q.data && <Pagination page={page} pageSize={50} total={q.data.total} onPage={setPage} />}
          </>
        )}
      </Card>
    </>
  );
}

// ---- Settings --------------------------------------------------------------------------------
const SETTING_TEXT: Record<string, string> = {
  'distribution.allow_own_screens': "Include an advertiser's own screens",
  'distribution.max_advertiser_share': 'Max loop share per advertiser (0.1–1)',
  'distribution.slots_per_loop': 'Ad slots per playlist loop',
  'distribution.require_host_subscription': 'Hosts need an active subscription to receive network ads',
  'devices.heartbeat_interval_seconds': 'Player heartbeat interval (seconds)',
  'devices.offline_after_seconds': 'Show screen offline after (seconds)',
  'devices.offline_cache_max_hours': 'Longest offline playback from cache (hours)',
  'pairing.code_ttl_seconds': 'Pairing code lifetime (seconds)',
};

export function AdminSettings() {
  const { data: me } = useMe();
  const superAdmin = isSuperAdmin(me);
  const qc = useQueryClient();
  const toast = useToast();
  const settings = useQuery({
    queryKey: ['admin', 'settings'],
    queryFn: () => api.get<Array<{ key: string; value: boolean | number; description?: string }>>('/api/admin/settings'),
  });
  const staff = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () =>
      api.get<Array<{ id: string; email: string; fullName: string; platformRole: string; totpEnabled: boolean; lastLoginAt: string | null }>>(
        '/api/admin/users',
      ),
    enabled: superAdmin,
  });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);
  const [newUser, setNewUser] = useState({ email: '', fullName: '', password: '', platformRole: 'NETWORK_OPERATOR' });
  const save = useMutation({
    mutationFn: ({ key, value }: { key: string; value: boolean | number }) => api.put(`/api/admin/settings/${key}`, { value }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'settings'] });
      toast.ok('Setting saved');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const addUser = useMutation({
    mutationFn: () => api.post('/api/admin/users', newUser),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      setAdding(false);
      toast.ok('Silva user created. They must set up two-factor authentication at first sign-in if they are a super admin.');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <>
      <PageHeader title="Settings" />
      <div className="space-y-6">
        <Card title="Platform settings" padded={false}>
          <Table>
            <tbody>
              {settings.data?.map((s) => (
                <tr key={s.key}>
                  <Td>
                    <div className="text-sm">{SETTING_TEXT[s.key] ?? s.key}</div>
                    <div className="font-mono text-[11px] text-muted">{s.key}</div>
                  </Td>
                  <Td className="w-64 text-right">
                    {typeof s.value === 'boolean' ? (
                      <Checkbox
                        label={s.value ? 'On' : 'Off'}
                        checked={s.value}
                        disabled={!superAdmin}
                        onChange={(v) => save.mutate({ key: s.key, value: v })}
                      />
                    ) : (
                      <div className="flex justify-end gap-2">
                        <Input
                          className="w-24"
                          type="number"
                          step="any"
                          aria-label={s.key}
                          disabled={!superAdmin}
                          value={drafts[s.key] ?? String(s.value)}
                          onChange={(e) => setDrafts({ ...drafts, [s.key]: e.target.value })}
                        />
                        {superAdmin && drafts[s.key] !== undefined && drafts[s.key] !== String(s.value) && (
                          <Button size="sm" onClick={() => save.mutate({ key: s.key, value: Number(drafts[s.key]) })}>
                            Save
                          </Button>
                        )}
                      </div>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
        {superAdmin && (
          <Card
            title="Silva Solutions staff"
            padded={false}
            actions={
              <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
                Add staff user
              </Button>
            }
          >
            <Table>
              <tbody>
                {staff.data?.map((u) => (
                  <tr key={u.id}>
                    <Td>
                      {u.fullName} <span className="text-muted">· {u.email}</span>
                    </Td>
                    <Td>
                      <Badge tone={u.platformRole === 'SUPER_ADMIN' ? 'accent' : 'neutral'}>
                        {u.platformRole === 'SUPER_ADMIN' ? 'Super admin' : 'Network operator'}
                      </Badge>
                    </Td>
                    <Td>{u.totpEnabled ? <Badge tone="ok">2FA on</Badge> : <Badge tone="warn">2FA off</Badge>}</Td>
                    <Td className="text-muted">last sign-in {fmtRelative(u.lastLoginAt)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        )}
        <SecurityCard />
      </div>
      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        title="Add Silva staff user"
        footer={
          <Button onClick={() => addUser.mutate()} loading={addUser.isPending}>
            Create
          </Button>
        }
      >
        <div className="space-y-4">
          <Field label="Full name" htmlFor="s-name">
            <Input id="s-name" value={newUser.fullName} onChange={(e) => setNewUser({ ...newUser, fullName: e.target.value })} />
          </Field>
          <Field label="Email" htmlFor="s-email">
            <Input id="s-email" type="email" value={newUser.email} onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} />
          </Field>
          <Field label="Temporary password" htmlFor="s-pw" hint="12+ characters">
            <Input
              id="s-pw"
              type="password"
              autoComplete="new-password"
              value={newUser.password}
              onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
            />
          </Field>
          <Field label="Role" htmlFor="s-role">
            <Select id="s-role" value={newUser.platformRole} onChange={(e) => setNewUser({ ...newUser, platformRole: e.target.value })}>
              <option value="NETWORK_OPERATOR">Network operator — reviews campaigns, monitors screens</option>
              <option value="SUPER_ADMIN">Super admin — full control</option>
            </Select>
          </Field>
        </div>
      </Dialog>
    </>
  );
}
