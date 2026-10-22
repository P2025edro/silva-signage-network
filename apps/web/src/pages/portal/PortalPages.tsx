import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, ExternalLink, Megaphone, MonitorPlay, Pencil, Plus, ShieldCheck, Tv, Users } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { useCompany, useMe } from '@/lib/auth';
import { fmtDate, fmtEuro, fmtNumber, fmtRelative } from '@/lib/format';
import { ENTITLEMENT_LABELS, type CampaignRow, type Location, type Paged, type Plan, type Screen, type SubscriptionState } from '@/lib/types';
import { CampaignStatus, ScreenHealth, SubscriptionStatus } from '@/components/status';
import { useToast } from '@/components/toast';
import { LocationDialog, MediaLibrary, MediaUploadButton, PairScreenDialog, PlaylistPanel, RulesDialog } from '@/components/features';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Notice,
  PageHeader,
  Select,
  Spinner,
  Stat,
  Table,
  Td,
  Th,
} from '@/components/ui';
import { MfaEnrol } from '../auth/AuthPages';

interface CompanyInfo {
  id: string;
  name: string;
  tradingName: string | null;
  contactName: string | null;
  email: string;
  phone: string | null;
  address: string | null;
  eircode: string | null;
  website: string | null;
  categoryId: string | null;
  status: string;
  isDevFixture: boolean;
  subscription: SubscriptionState;
  counts: { locations: number; screens: number; liveCampaigns: number };
}

export const useCompanyInfo = () => {
  const { base, companyId } = useCompany();
  return useQuery({ queryKey: ['company', companyId], queryFn: () => api.get<CompanyInfo>(base) });
};

// ---- Overview ---------------------------------------------------------------------
export function PortalOverview() {
  const { base } = useCompany();
  const info = useCompanyInfo();
  const screens = useQuery({ queryKey: ['screens', base], queryFn: () => api.get<Screen[]>(`${base}/screens`) });
  const campaigns = useQuery({ queryKey: ['campaigns', base, 'recent'], queryFn: () => api.get<Paged<CampaignRow>>(`${base}/campaigns?pageSize=5`) });
  const notes = useQuery({
    queryKey: ['notifications', base],
    queryFn: () => api.get<Array<{ id: string; message: string; createdAt: string }>>(`${base}/notifications`),
  });
  if (info.isLoading) return <Spinner />;
  if (info.error) return <ErrorState error={info.error} retry={info.refetch} />;
  const c = info.data!;
  const sub = c.subscription;
  const attention = (screens.data ?? []).filter((s) => ['OFFLINE', 'ERROR', 'STALLED'].includes(s.health));
  const alloc = sub.entitlements.monthly_playback_allocation ?? 0;
  return (
    <>
      <PageHeader
        title={c.name}
        description="Your adverts across the Silva Signage Network, and the network adverts on your screens."
        actions={
          <Link to="/portal/campaigns/new">
            <Button>
              <Plus className="size-4" /> New campaign
            </Button>
          </Link>
        }
      />
      {!sub.active && (
        <div className="mb-6">
          <Notice tone="warn" title="No active subscription">
            Your adverts won't be distributed and you can't add screens until a subscription is active.{' '}
            <Link to="/portal/billing" className="font-medium text-ink underline">
              View subscription
            </Link>
          </Notice>
        </div>
      )}
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label="Plan"
          value={sub.subscription?.planName ?? '—'}
          sub={<SubscriptionStatus status={sub.subscription?.status} source={sub.subscription?.source} />}
        />
        <Stat label="Live campaigns" value={c.counts.liveCampaigns} sub={`of ${sub.entitlements.max_active_campaigns ?? 0} allowed`} />
        <Stat
          label="Your screens"
          value={c.counts.screens}
          sub={attention.length ? <span className="text-bad">{attention.length} need attention</span> : 'all healthy'}
        />
        <Stat label="Playbacks this period" value={fmtNumber(sub.playsThisPeriod)} sub={alloc ? `of ${fmtNumber(alloc)} allocation` : undefined} />
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <Card
          title="Recent campaigns"
          className="lg:col-span-2"
          padded={false}
          actions={
            <Link to="/portal/campaigns" className="text-xs text-muted hover:text-ink">
              View all
            </Link>
          }
        >
          {campaigns.data?.items.length ? (
            <Table>
              <tbody>
                {campaigns.data.items.map((r) => (
                  <tr key={r.id} className="hover:bg-subtle/50">
                    <Td>
                      <Link to={`/portal/campaigns/${r.id}`} className="font-medium hover:underline">
                        {r.name}
                      </Link>
                      <div className="text-xs text-muted">
                        {fmtDate(r.startAt)} – {fmtDate(r.endAt)}
                      </div>
                    </Td>
                    <Td>
                      <CampaignStatus status={r.status} />
                    </Td>
                    <Td className="tabular text-right text-muted">{fmtNumber(r.playbackStarts)} plays</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <EmptyState
              icon={<Megaphone className="size-6" />}
              title="No campaigns yet"
              action={
                <Link to="/portal/campaigns/new">
                  <Button size="sm">Create your first campaign</Button>
                </Link>
              }
            >
              Upload an image or video, choose where it should run, and submit it for approval.
            </EmptyState>
          )}
        </Card>
        <Card title="Updates">
          {notes.data?.length ? (
            <ul className="space-y-3">
              {notes.data.slice(0, 6).map((n) => (
                <li key={n.id} className="text-sm">
                  <div>{n.message}</div>
                  <div className="text-xs text-muted">{fmtRelative(n.createdAt)}</div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">Review decisions and account notices will appear here.</p>
          )}
        </Card>
      </div>
      {attention.length > 0 && (
        <div className="mt-6">
          <Card title="Screens needing attention" padded={false}>
            <ScreenTable screens={attention} />
          </Card>
        </div>
      )}
    </>
  );
}

// ---- Campaign list -----------------------------------------------------------------
export function PortalCampaigns() {
  const { base } = useCompany();
  const [status, setStatus] = useState('');
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['campaigns', base, status],
    queryFn: () => api.get<Paged<CampaignRow>>(`${base}/campaigns?pageSize=100${status ? `&status=${status}` : ''}`),
  });
  return (
    <>
      <PageHeader
        title="Campaigns"
        description="Adverts you distribute across other participating businesses."
        actions={
          <Link to="/portal/campaigns/new">
            <Button>
              <Plus className="size-4" /> New campaign
            </Button>
          </Link>
        }
      />
      <Card padded={false}>
        <div className="flex gap-2 border-b border-line p-3">
          <Select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-56">
            <option value="">All statuses</option>
            <option value="DRAFT,CHANGES_REQUESTED">Drafts & changes requested</option>
            <option value="SUBMITTED,UNDER_REVIEW">Awaiting approval</option>
            <option value="SCHEDULED,ACTIVE,PAUSED">Live</option>
            <option value="COMPLETED,CANCELLED,REJECTED">Finished</option>
          </Select>
        </div>
        {isLoading ? (
          <Spinner />
        ) : error ? (
          <ErrorState error={error} retry={refetch} />
        ) : !data?.items.length ? (
          <EmptyState icon={<Megaphone className="size-6" />} title="No campaigns here" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Campaign</Th>
                <Th>Status</Th>
                <Th>Runs</Th>
                <Th className="text-right">Creatives</Th>
                <Th className="text-right">Playbacks</Th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((r) => (
                <tr key={r.id} className="hover:bg-subtle/50">
                  <Td>
                    <Link to={`/portal/campaigns/${r.id}`} className="font-medium hover:underline">
                      {r.name}
                    </Link>
                  </Td>
                  <Td>
                    <CampaignStatus status={r.status} />
                  </Td>
                  <Td className="text-muted">
                    {fmtDate(r.startAt)} – {fmtDate(r.endAt)}
                  </Td>
                  <Td className="tabular text-right">{r.mediaCount}</Td>
                  <Td className="tabular text-right">{fmtNumber(r.playbackStarts)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}

// ---- Media ---------------------------------------------------------------------
export function PortalMedia() {
  const { base } = useCompany();
  return (
    <>
      <PageHeader
        title="Media library"
        description="Images and videos for your campaigns. Every upload is checked and prepared for TV playback."
        actions={<MediaUploadButton base={base} />}
      />
      <Card>
        <MediaLibrary base={base} />
      </Card>
    </>
  );
}

// ---- Establishments & screens ------------------------------------------------------
export function ScreenTable({
  screens,
  onSelect,
  onRename,
  onUnpair,
}: {
  screens: Screen[];
  onSelect?: (s: Screen) => void;
  onRename?: (s: Screen) => void;
  onUnpair?: (s: Screen) => void;
}) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>Screen</Th>
          <Th>Status</Th>
          <Th>Last seen</Th>
          <Th>Device</Th>
          {(onRename || onUnpair) && <Th />}
        </tr>
      </thead>
      <tbody>
        {screens.map((s) => (
          <tr key={s.id} className="hover:bg-subtle/50">
            <Td>
              <button className="text-left font-medium hover:underline" onClick={() => onSelect?.(s)} disabled={!onSelect}>
                {s.displayName}
              </button>
              <div className="text-xs text-muted">{s.locationName}</div>
            </Td>
            <Td>
              <ScreenHealth health={s.health} />
              {s.lastError && (
                <div className="mt-1 max-w-56 truncate text-xs text-bad" title={s.lastError}>
                  {s.lastError}
                </div>
              )}
            </Td>
            <Td className="text-muted">{fmtRelative(s.lastHeartbeatAt)}</Td>
            <Td className="text-xs text-muted">
              {s.platform ?? '—'}
              {s.resolution && <div>{s.resolution}</div>}
            </Td>
            {(onRename || onUnpair) && (
              <Td className="text-right whitespace-nowrap">
                {onRename && (
                  <Button size="sm" variant="ghost" onClick={() => onRename(s)}>
                    Rename
                  </Button>
                )}
                {onUnpair && (
                  <Button size="sm" variant="ghost" className="text-bad" onClick={() => onUnpair(s)}>
                    Unpair
                  </Button>
                )}
              </Td>
            )}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export function PortalEstablishments() {
  const { base, isOwner } = useCompany();
  const qc = useQueryClient();
  const toast = useToast();
  const locations = useQuery({ queryKey: ['locations', base], queryFn: () => api.get<Location[]>(`${base}/locations`) });
  const screens = useQuery({ queryKey: ['screens', base], queryFn: () => api.get<Screen[]>(`${base}/screens`), refetchInterval: 30_000 });
  const [editing, setEditing] = useState<Location | null | 'new'>(null);
  const [rulesFor, setRulesFor] = useState<Location | null>(null);
  const [pairing, setPairing] = useState(false);
  const [viewing, setViewing] = useState<Screen | null>(null);
  const [renaming, setRenaming] = useState<Screen | null>(null);
  const [newName, setNewName] = useState('');
  const [unpairing, setUnpairing] = useState<Screen | null>(null);

  const rename = useMutation({
    mutationFn: () => api.patch(`${base}/screens/${renaming!.id}`, { displayName: newName }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['screens'] });
      setRenaming(null);
      toast.ok('Screen renamed');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const unpair = useMutation({
    mutationFn: () => api.post(`${base}/screens/${unpairing!.id}/unpair`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['screens'] });
      setUnpairing(null);
      toast.ok('Screen unpaired. The TV will return to the pairing screen.');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (locations.isLoading) return <Spinner />;
  return (
    <>
      <PageHeader
        title="Establishments & screens"
        description="Your premises, the TVs installed in them, and which adverts they accept."
        actions={
          isOwner && (
            <>
              <Button variant="outline" onClick={() => setEditing('new')}>
                <Plus className="size-4" /> Add establishment
              </Button>
              <Button onClick={() => setPairing(true)}>
                <Tv className="size-4" /> Pair a screen
              </Button>
            </>
          )
        }
      />
      <div className="space-y-6">
        <Card title="Establishments" padded={false}>
          {!locations.data?.length ? (
            <EmptyState
              icon={<Building2 className="size-6" />}
              title="No establishments yet"
              action={
                isOwner && (
                  <Button size="sm" onClick={() => setEditing('new')}>
                    Add establishment
                  </Button>
                )
              }
            >
              Add each premises where you have, or will install, a screen.
            </EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Establishment</Th>
                  <Th>Zones</Th>
                  <Th>Network adverts</Th>
                  <Th className="text-right">Screens</Th>
                  {isOwner && <Th />}
                </tr>
              </thead>
              <tbody>
                {locations.data.map((l) => (
                  <tr key={l.id}>
                    <Td>
                      <div className="font-medium">{l.name}</div>
                      <div className="text-xs text-muted">
                        {l.streetAddress}
                        {l.eircode && `, ${l.eircode}`}
                      </div>
                    </Td>
                    <Td className="text-xs text-muted">{l.zoneNames.join(', ') || '—'}</Td>
                    <Td>
                      {l.participatesInNetwork ? <Badge tone="ok">Participating</Badge> : <Badge>Opted out</Badge>}
                      {(l.blockCategoryIds.length > 0 || l.allowCategoryIds.length > 0) && <div className="mt-1 text-xs text-muted">Category rules set</div>}
                    </Td>
                    <Td className="tabular text-right">{l.screenCount}</Td>
                    {isOwner && (
                      <Td className="text-right whitespace-nowrap">
                        <Button size="sm" variant="ghost" onClick={() => setRulesFor(l)}>
                          <ShieldCheck className="size-3.5" /> Rules
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(l)}>
                          <Pencil className="size-3.5" /> Edit
                        </Button>
                      </Td>
                    )}
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card title="Screens" padded={false}>
          {screens.isLoading ? (
            <Spinner />
          ) : !screens.data?.length ? (
            <EmptyState
              icon={<MonitorPlay className="size-6" />}
              title="No screens paired"
              action={
                isOwner && (
                  <Button size="sm" onClick={() => setPairing(true)}>
                    Pair a screen
                  </Button>
                )
              }
            >
              On the TV, open the web browser and go to the Silva player address. It will show a pairing code to enter here.
            </EmptyState>
          ) : (
            <ScreenTable
              screens={screens.data}
              onSelect={setViewing}
              onRename={
                isOwner
                  ? (s) => {
                      setRenaming(s);
                      setNewName(s.displayName);
                    }
                  : undefined
              }
              onUnpair={isOwner ? setUnpairing : undefined}
            />
          )}
        </Card>
      </div>

      <LocationDialog open={editing !== null} onClose={() => setEditing(null)} base={base} location={editing === 'new' ? null : editing} />
      <RulesDialog open={rulesFor !== null} onClose={() => setRulesFor(null)} base={base} location={rulesFor} />
      <PairScreenDialog open={pairing} onClose={() => setPairing(false)} base={base} locations={locations.data ?? []} />
      <Dialog
        open={viewing !== null}
        onClose={() => setViewing(null)}
        wide
        title={viewing?.displayName ?? ''}
        description={`${viewing?.locationName ?? ''} · what's playing now`}
      >
        {viewing && <PlaylistPanel url={`${base}/screens/${viewing.id}/playlist`} />}
      </Dialog>
      <Dialog
        open={renaming !== null}
        onClose={() => setRenaming(null)}
        title="Rename screen"
        footer={
          <Button onClick={() => rename.mutate()} loading={rename.isPending} disabled={newName.trim().length < 2}>
            Save
          </Button>
        }
      >
        <Field label="Screen name" htmlFor="rename">
          <Input id="rename" value={newName} onChange={(e) => setNewName(e.target.value)} />
        </Field>
      </Dialog>
      <ConfirmDialog
        open={unpairing !== null}
        onClose={() => setUnpairing(null)}
        onConfirm={() => unpair.mutate()}
        loading={unpair.isPending}
        danger
        title="Unpair this screen?"
        confirmLabel="Unpair"
      >
        “{unpairing?.displayName}” will stop playing and its access will be revoked. You can pair it again later with a new code.
      </ConfirmDialog>
    </>
  );
}

// ---- Billing ------------------------------------------------------------------
export function PortalBilling() {
  const { base, isOwner } = useCompany();
  const toast = useToast();
  const billing = useQuery({
    queryKey: ['billing', base],
    queryFn: () =>
      api.get<
        SubscriptionState & {
          invoices: Array<{ id: string; type: string; amountCents: number | null; receivedAt: string; invoiceUrl: string | null }>;
          onlineBillingAvailable: boolean;
        }
      >(`${base}/billing`),
  });
  const plans = useQuery({ queryKey: ['plans'], queryFn: () => api.get<Plan[]>('/api/plans') });
  const go = useMutation({
    mutationFn: (path: string) => api.post<{ url: string }>(path, path.endsWith('checkout') ? { planCode: selectedPlan } : {}),
    onSuccess: (r) => window.location.assign(r.url),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const [selectedPlan, setSelectedPlan] = useState('');
  if (billing.isLoading) return <Spinner />;
  if (billing.error) return <ErrorState error={billing.error} />;
  const b = billing.data!;
  return (
    <>
      <PageHeader title="Subscription" description="Your plan determines how many screens and campaigns you can run, and your share of network playback." />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Current plan" className="lg:col-span-2">
          {b.subscription ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-lg font-semibold">{b.subscription.planName}</span>
                <SubscriptionStatus status={b.subscription.status} source={b.subscription.source} />
              </div>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <dt className="text-muted">Current period</dt>
                <dd>
                  {fmtDate(b.subscription.currentPeriodStart)} – {fmtDate(b.subscription.currentPeriodEnd)}
                </dd>
                <dt className="text-muted">{b.subscription.cancelAtPeriodEnd ? 'Ends' : 'Renews'}</dt>
                <dd>{fmtDate(b.subscription.currentPeriodEnd)}</dd>
                {Object.entries(b.entitlements).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted">{ENTITLEMENT_LABELS[k] ?? k}</dt>
                    <dd className="tabular">{fmtNumber(v)}</dd>
                  </div>
                ))}
              </dl>
              {b.subscription.source === 'MANUAL' && (
                <Notice>This subscription was set up by Silva Solutions (for example during a pilot). It is not billed online.</Notice>
              )}
              {isOwner && b.subscription.source === 'STRIPE' && (
                <Button variant="outline" onClick={() => go.mutate(`${base}/billing/portal`)} loading={go.isPending}>
                  Manage payment & invoices <ExternalLink className="size-3.5" />
                </Button>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted">No active subscription.</p>
          )}
        </Card>
        <Card title="Change or start a plan">
          {!b.onlineBillingAvailable ? (
            <Notice>Online payment isn't available yet. Contact Silva Solutions to start or change your subscription.</Notice>
          ) : isOwner ? (
            <div className="space-y-3">
              <Select aria-label="Plan" value={selectedPlan} onChange={(e) => setSelectedPlan(e.target.value)}>
                <option value="">Choose a plan…</option>
                {plans.data
                  ?.filter((p) => p.onlineCheckout)
                  .map((p) => (
                    <option key={p.code} value={p.code}>
                      {p.name} — {fmtEuro(p.monthlyPriceCents)}/month
                    </option>
                  ))}
              </Select>
              <Button className="w-full" disabled={!selectedPlan} onClick={() => go.mutate(`${base}/billing/checkout`)} loading={go.isPending}>
                Continue to secure checkout
              </Button>
              <p className="text-xs text-muted">Payments are handled by Stripe. Card details never reach Silva Solutions.</p>
            </div>
          ) : (
            <p className="text-sm text-muted">Only the account owner can change the subscription.</p>
          )}
        </Card>
      </div>
      <div className="mt-6">
        <Card title="Billing history" padded={false}>
          {b.invoices.length === 0 ? (
            <p className="p-5 text-sm text-muted">No invoices yet.</p>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th>Event</Th>
                  <Th className="text-right">Amount</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {b.invoices.map((i) => (
                  <tr key={i.id}>
                    <Td>{fmtDate(i.receivedAt)}</Td>
                    <Td>
                      {i.type === 'invoice.paid' ? (
                        <Badge tone="ok">Paid</Badge>
                      ) : i.type === 'invoice.payment_failed' ? (
                        <Badge tone="bad">Payment failed</Badge>
                      ) : (
                        i.type
                      )}
                    </Td>
                    <Td className="tabular text-right">{fmtEuro(i.amountCents)}</Td>
                    <Td className="text-right">
                      {i.invoiceUrl && (
                        <a href={i.invoiceUrl} target="_blank" rel="noreferrer" className="text-xs text-muted hover:text-ink">
                          View invoice
                        </a>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}

// ---- Team -------------------------------------------------------------------------
export function PortalTeam() {
  const { base, isOwner } = useCompany();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const users = useQuery({
    queryKey: ['users', base],
    queryFn: () => api.get<Array<{ id: string; email: string; fullName: string; role: string; lastLoginAt: string | null }>>(`${base}/users`),
  });
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ email: '', fullName: '', password: '', role: 'STAFF' });
  const add = useMutation({
    mutationFn: () => api.post(`${base}/users`, form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      setAdding(false);
      toast.ok('User added. Share the temporary password with them securely.');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.del(`${base}/users/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <>
      <PageHeader
        title="Team"
        description="People who can manage this business's campaigns and screens."
        actions={
          isOwner && (
            <Button
              onClick={() => {
                setForm({ email: '', fullName: '', password: '', role: 'STAFF' });
                setAdding(true);
              }}
            >
              <Plus className="size-4" /> Add user
            </Button>
          )
        }
      />
      <Card padded={false}>
        {users.isLoading ? (
          <Spinner />
        ) : !users.data?.length ? (
          <EmptyState icon={<Users className="size-6" />} title="No users" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Role</Th>
                <Th>Last sign-in</Th>
                {isOwner && <Th />}
              </tr>
            </thead>
            <tbody>
              {users.data.map((u) => (
                <tr key={u.id}>
                  <Td>
                    <div className="font-medium">{u.fullName}</div>
                    <div className="text-xs text-muted">{u.email}</div>
                  </Td>
                  <Td>
                    <Badge tone={u.role === 'OWNER' ? 'accent' : 'neutral'}>{u.role === 'OWNER' ? 'Owner' : 'Staff'}</Badge>
                  </Td>
                  <Td className="text-muted">{fmtRelative(u.lastLoginAt)}</Td>
                  {isOwner && (
                    <Td className="text-right">
                      {u.id !== me?.user.id && (
                        <Button size="sm" variant="ghost" className="text-bad" onClick={() => remove.mutate(u.id)}>
                          Remove
                        </Button>
                      )}
                    </Td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <p className="mt-3 text-xs text-muted">Owners can submit campaigns, pair screens and manage billing. Staff can prepare campaigns and upload media.</p>
      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        title="Add a user"
        footer={
          <Button onClick={() => add.mutate()} loading={add.isPending}>
            Add user
          </Button>
        }
      >
        <div className="space-y-4">
          <Field label="Full name" htmlFor="u-name">
            <Input id="u-name" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
          </Field>
          <Field label="Email" htmlFor="u-email">
            <Input id="u-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
          <Field label="Temporary password" htmlFor="u-pass" hint="At least 12 characters. Ask them to change it after signing in.">
            <Input
              id="u-pass"
              type="password"
              autoComplete="new-password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </Field>
          <Field label="Role" htmlFor="u-role">
            <Select id="u-role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="STAFF">Staff</option>
              <option value="OWNER">Owner</option>
            </Select>
          </Field>
        </div>
      </Dialog>
    </>
  );
}

// ---- Settings (company profile + personal security) ------------------------------------
export function SecurityCard() {
  const { data: me, refetch } = useMe();
  const toast = useToast();
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const change = useMutation({
    mutationFn: () => api.post('/api/auth/password', pw),
    onSuccess: () => {
      toast.ok('Password changed. Other sessions were signed out.');
      setPw({ currentPassword: '', newPassword: '' });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Card title="Your sign-in">
      <div className="grid gap-8 md:grid-cols-2">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            change.mutate();
          }}
        >
          <h3 className="text-sm font-medium">Change password</h3>
          <Field label="Current password" htmlFor="cur-pw">
            <Input
              id="cur-pw"
              type="password"
              autoComplete="current-password"
              value={pw.currentPassword}
              onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })}
            />
          </Field>
          <Field label="New password" htmlFor="new-pw" hint="At least 12 characters.">
            <Input
              id="new-pw"
              type="password"
              autoComplete="new-password"
              value={pw.newPassword}
              onChange={(e) => setPw({ ...pw, newPassword: e.target.value })}
            />
          </Field>
          <Button type="submit" variant="outline" loading={change.isPending}>
            Change password
          </Button>
        </form>
        <div>
          <h3 className="mb-3 text-sm font-medium">Two-factor authentication</h3>
          {me?.user.totpEnabled ? (
            <Badge tone="ok">Enabled</Badge>
          ) : (
            <MfaEnrol
              onDone={() => {
                toast.ok('Two-factor authentication is on');
                refetch();
              }}
            />
          )}
        </div>
      </div>
    </Card>
  );
}

export function PortalSettings() {
  const { base, isOwner } = useCompany();
  const info = useCompanyInfo();
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<Record<string, string> | null>(null);
  const save = useMutation({
    mutationFn: () => api.patch(base, Object.fromEntries(Object.entries(form!).map(([k, v]) => [k, v || null]))),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['company'] });
      toast.ok('Business details saved');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (info.isLoading) return <Spinner />;
  const c = info.data!;
  const f =
    form ??
    ({
      name: c.name,
      tradingName: c.tradingName ?? '',
      contactName: c.contactName ?? '',
      email: c.email,
      phone: c.phone ?? '',
      address: c.address ?? '',
      eircode: c.eircode ?? '',
      website: c.website ?? '',
      categoryId: c.categoryId ?? '',
    } as Record<string, string>);
  const fields: Array<[string, string]> = [
    ['name', 'Company name'],
    ['tradingName', 'Trading name'],
    ['contactName', 'Contact person'],
    ['email', 'Business email'],
    ['phone', 'Telephone'],
    ['address', 'Registered or operating address'],
    ['eircode', 'Eircode'],
    ['website', 'Website'],
  ];
  return (
    <>
      <PageHeader title="Settings" />
      <div className="space-y-6">
        <Card title="Business details">
          <form
            className="grid gap-4 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate();
            }}
          >
            {fields.map(([k, label]) => (
              <Field key={k} label={label} htmlFor={`co-${k}`}>
                <Input id={`co-${k}`} value={f[k] ?? ''} disabled={!isOwner} onChange={(e) => setForm({ ...f, [k]: e.target.value })} />
              </Field>
            ))}
            {isOwner && (
              <div className="sm:col-span-2">
                <Button type="submit" loading={save.isPending}>
                  Save details
                </Button>
              </div>
            )}
          </form>
        </Card>
        <SecurityCard />
      </div>
    </>
  );
}
