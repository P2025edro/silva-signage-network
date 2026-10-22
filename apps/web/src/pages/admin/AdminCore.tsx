import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Building2, MonitorPlay, Plus, RefreshCw } from 'lucide-react';
import { api, errorMessage, fieldErrors } from '@/lib/api';
import { isSuperAdmin, useMe } from '@/lib/auth';
import { fmtDate, fmtDateTime, fmtEuro, fmtNumber, fmtRelative } from '@/lib/format';
import type { CampaignRow, Location, Paged, Plan, Screen, SubscriptionState } from '@/lib/types';
import { BarChart } from '@/components/charts';
import { LocationDialog, PlaylistPanel, RulesDialog, useCategories } from '@/components/features';
import { CampaignStatus, DevFixture, ScreenHealth, SubscriptionStatus } from '@/components/status';
import { useToast } from '@/components/toast';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
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
  Td,
  Th,
} from '@/components/ui';
import { ScreenTable } from '../portal/PortalPages';

// ---- Overview ------------------------------------------------------------------------
interface Overview {
  companies: number;
  devFixtureCompanies: number;
  activeSubscriptions: number;
  paidSubscriptions: number;
  activeCampaigns: number;
  pendingCampaigns: number;
  playbackStarts24h: number;
  playbackFailures24h: number;
  verifiedMrrCents: number;
  paidInvoices30dCents: number;
  screens: { total: number; online: number; offline: number; playing: number; errors: number; disabled: number };
  networkHealthPct: number | null;
  playbackByDay: Array<{ day: string; starts: number; failures: number }>;
}

export function AdminOverview() {
  const o = useQuery({ queryKey: ['admin', 'overview'], queryFn: () => api.get<Overview>('/api/admin/overview'), refetchInterval: 30_000 });
  const pending = useQuery({
    queryKey: ['admin', 'campaigns', 'pending'],
    queryFn: () => api.get<Paged<CampaignRow>>('/api/admin/campaigns?status=SUBMITTED,UNDER_REVIEW&pageSize=5'),
  });
  if (o.isLoading) return <Spinner />;
  if (o.error) return <ErrorState error={o.error} retry={o.refetch} />;
  const d = o.data!;
  return (
    <>
      <PageHeader title="Network overview" description="Live state of the Silva Signage Network. Revenue figures use verified Stripe records only." />
      {d.devFixtureCompanies > 0 && (
        <div className="mb-6">
          <Notice tone="warn" title="Development fixtures present">
            {d.devFixtureCompanies} of {d.companies} companies are labelled development fixtures. Their activity is not real customer activity.
          </Notice>
        </div>
      )}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Companies" value={fmtNumber(d.companies)} sub={`${d.activeSubscriptions} with active subscriptions`} />
        <Stat
          label="Screens online"
          value={`${d.screens.online} / ${d.screens.total}`}
          sub={d.networkHealthPct === null ? 'no active screens' : `${d.networkHealthPct}% network health`}
          tone={d.networkHealthPct !== null && d.networkHealthPct < 80 ? 'warn' : undefined}
        />
        <Stat
          label="Active campaigns"
          value={d.activeCampaigns}
          sub={
            d.pendingCampaigns ? (
              <Link to="/admin/campaigns" className="text-accent hover:underline">
                {d.pendingCampaigns} awaiting review
              </Link>
            ) : (
              'none awaiting review'
            )
          }
        />
        <Stat label="Verified MRR" value={fmtEuro(d.verifiedMrrCents)} sub={`${d.paidSubscriptions} paying via Stripe`} />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Offline screens" value={d.screens.offline} tone={d.screens.offline ? 'bad' : undefined} />
        <Stat label="Playback errors / stalls" value={d.screens.errors} tone={d.screens.errors ? 'warn' : undefined} />
        <Stat label="Playback starts (24h)" value={fmtNumber(d.playbackStarts24h)} sub={`${fmtNumber(d.playbackFailures24h)} failures`} />
        <Stat label="Paid invoices (30 days)" value={fmtEuro(d.paidInvoices30dCents)} />
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card title="Playback, last 14 days" className="lg:col-span-2">
          {d.playbackByDay.some((x) => x.starts || x.failures) ? (
            <BarChart
              data={d.playbackByDay}
              series={[
                { key: 'starts', label: 'Starts', className: 'fill-accent' },
                { key: 'failures', label: 'Failures', className: 'fill-bad' },
              ]}
            />
          ) : (
            <EmptyState title="No playback reported yet">Once paired screens play approved adverts, daily playback appears here.</EmptyState>
          )}
        </Card>
        <Card title="Awaiting review" padded={false}>
          {pending.data?.items.length ? (
            <ul className="divide-y divide-line">
              {pending.data.items.map((c) => (
                <li key={c.id}>
                  <Link to={`/admin/campaigns/${c.id}`} className="block px-5 py-3 hover:bg-subtle/50">
                    <div className="text-sm font-medium">{c.name}</div>
                    <div className="text-xs text-muted">
                      {c.companyName} · submitted {fmtRelative(c.submittedAt)}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="p-5 text-sm text-muted">Nothing to review.</p>
          )}
        </Card>
      </div>
    </>
  );
}

// ---- Companies -------------------------------------------------------------------------
interface CompanyRow {
  id: string;
  name: string;
  trading_name: string | null;
  email: string;
  status: string;
  is_dev_fixture: boolean;
  category: string | null;
  locations: number;
  screens: number;
  subscription_status: string | null;
  plan_name: string | null;
  created_at: string;
}

export function AdminCompanies() {
  const { data: me } = useMe();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const q = useQuery({
    queryKey: ['admin', 'companies', page, search],
    queryFn: () => api.get<Paged<CompanyRow>>(`/api/admin/companies?page=${page}&pageSize=25${search ? `&search=${encodeURIComponent(search)}` : ''}`),
  });
  return (
    <>
      <PageHeader
        title="Companies"
        description="Businesses subscribed to the network."
        actions={
          isSuperAdmin(me) && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" /> New company
            </Button>
          )
        }
      />
      <Card padded={false}>
        <div className="border-b border-line p-3">
          <Input
            placeholder="Search by name or email"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="max-w-sm"
            aria-label="Search companies"
          />
        </div>
        {q.isLoading ? (
          <Spinner />
        ) : q.error ? (
          <ErrorState error={q.error} />
        ) : !q.data?.items.length ? (
          <EmptyState icon={<Building2 className="size-6" />} title={search ? 'No matches' : 'No companies yet'} />
        ) : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th>Company</Th>
                  <Th>Subscription</Th>
                  <Th className="text-right">Locations</Th>
                  <Th className="text-right">Screens</Th>
                  <Th>Status</Th>
                  <Th>Joined</Th>
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((c) => (
                  <tr key={c.id} className="hover:bg-subtle/50">
                    <Td>
                      <Link to={`/admin/companies/${c.id}`} className="font-medium hover:underline">
                        {c.name}
                      </Link>{' '}
                      {c.is_dev_fixture && <DevFixture />}
                      <div className="text-xs text-muted">{c.category ?? c.email}</div>
                    </Td>
                    <Td>
                      {c.plan_name && <span className="mr-2 text-sm">{c.plan_name}</span>}
                      <SubscriptionStatus status={c.subscription_status} />
                    </Td>
                    <Td className="tabular text-right">{c.locations}</Td>
                    <Td className="tabular text-right">{c.screens}</Td>
                    <Td>{c.status === 'ACTIVE' ? <Badge tone="ok">Active</Badge> : <Badge tone="bad">{c.status}</Badge>}</Td>
                    <Td className="text-muted">{fmtDate(c.created_at)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <Pagination page={page} pageSize={25} total={q.data.total} onPage={setPage} />
          </>
        )}
      </Card>
      <CreateCompanyDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function CreateCompanyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  const { data: categories } = useCategories();
  const blank = {
    name: '',
    tradingName: '',
    email: '',
    phone: '',
    eircode: '',
    categoryId: '',
    isDevFixture: false,
    withOwner: true,
    ownerName: '',
    ownerEmail: '',
    ownerPassword: '',
  };
  const [f, setF] = useState(blank);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const create = useMutation({
    mutationFn: () =>
      api.post<{ id: string }>('/api/admin/companies', {
        name: f.name,
        tradingName: f.tradingName || null,
        email: f.email,
        phone: f.phone || null,
        eircode: f.eircode || null,
        categoryId: f.categoryId || null,
        isDevFixture: f.isDevFixture,
        owner: f.withOwner ? { fullName: f.ownerName, email: f.ownerEmail, password: f.ownerPassword } : undefined,
      }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['admin', 'companies'] });
      toast.ok('Company created');
      setF(blank);
      onClose();
      nav(`/admin/companies/${r.id}`);
    },
    onError: (e) => {
      setErrors(fieldErrors(e));
      toast.error(errorMessage(e));
    },
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title="New company"
      footer={
        <Button onClick={() => create.mutate()} loading={create.isPending}>
          Create company
        </Button>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Company name" htmlFor="nc-name" error={errors.name}>
          <Input id="nc-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Trading name" htmlFor="nc-trading">
          <Input id="nc-trading" value={f.tradingName} onChange={(e) => setF({ ...f, tradingName: e.target.value })} />
        </Field>
        <Field label="Business email" htmlFor="nc-email" error={errors.email}>
          <Input id="nc-email" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </Field>
        <Field label="Telephone" htmlFor="nc-phone">
          <Input id="nc-phone" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        </Field>
        <Field label="Eircode" htmlFor="nc-eir" error={errors.eircode}>
          <Input id="nc-eir" value={f.eircode} onChange={(e) => setF({ ...f, eircode: e.target.value })} />
        </Field>
        <Field label="Business category" htmlFor="nc-cat">
          <Select id="nc-cat" value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}>
            <option value="">Not specified</option>
            {categories?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="space-y-2 sm:col-span-2">
          <Checkbox
            label="This is a development / test fixture (never a real customer)"
            checked={f.isDevFixture}
            onChange={(v) => setF({ ...f, isDevFixture: v })}
          />
          <Checkbox label="Create the owner's sign-in now" checked={f.withOwner} onChange={(v) => setF({ ...f, withOwner: v })} />
        </div>
        {f.withOwner && (
          <>
            <Field label="Owner name" htmlFor="nc-oname">
              <Input id="nc-oname" value={f.ownerName} onChange={(e) => setF({ ...f, ownerName: e.target.value })} />
            </Field>
            <Field label="Owner email" htmlFor="nc-oemail">
              <Input id="nc-oemail" type="email" value={f.ownerEmail} onChange={(e) => setF({ ...f, ownerEmail: e.target.value })} />
            </Field>
            <Field label="Temporary password" htmlFor="nc-opw" hint="12+ characters. Share securely; ask them to change it." className="sm:col-span-2">
              <Input
                id="nc-opw"
                type="password"
                autoComplete="new-password"
                value={f.ownerPassword}
                onChange={(e) => setF({ ...f, ownerPassword: e.target.value })}
              />
            </Field>
          </>
        )}
      </div>
    </Dialog>
  );
}

export function AdminCompanyDetail() {
  const { companyId } = useParams();
  const { data: me } = useMe();
  const superAdmin = isSuperAdmin(me);
  const base = `/api/companies/${companyId}`;
  const qc = useQueryClient();
  const toast = useToast();
  const company = useQuery({
    queryKey: ['company', companyId],
    queryFn: () =>
      api.get<{
        id: string;
        name: string;
        email: string;
        phone: string | null;
        eircode: string | null;
        status: string;
        isDevFixture: boolean;
        createdAt: string;
        subscription: SubscriptionState;
        counts: Record<string, number>;
      }>(base),
  });
  const locations = useQuery({ queryKey: ['locations', base], queryFn: () => api.get<Location[]>(`${base}/locations`) });
  const screens = useQuery({ queryKey: ['screens', base], queryFn: () => api.get<Screen[]>(`${base}/screens`) });
  const campaigns = useQuery({ queryKey: ['campaigns', base], queryFn: () => api.get<Paged<CampaignRow>>(`${base}/campaigns?pageSize=50`) });
  const users = useQuery({
    queryKey: ['users', base],
    queryFn: () => api.get<Array<{ id: string; email: string; fullName: string; role: string; lastLoginAt: string | null }>>(`${base}/users`),
  });
  const plans = useQuery({ queryKey: ['plans'], queryFn: () => api.get<Plan[]>('/api/plans') });
  const [granting, setGranting] = useState(false);
  const [grant, setGrant] = useState({ planCode: 'starter', periodDays: 30, note: '' });
  const [editingLoc, setEditingLoc] = useState<Location | null | 'new'>(null);
  const [suspendOpen, setSuspendOpen] = useState(false);

  const doGrant = useMutation({
    mutationFn: () => api.post(`/api/admin/companies/${companyId}/subscriptions/manual`, grant),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['company', companyId] });
      setGranting(false);
      toast.ok('Manual subscription granted');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const setStatus = useMutation({
    mutationFn: (status: string) => api.post(`/api/admin/companies/${companyId}/status`, { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['company', companyId] });
      setSuspendOpen(false);
      toast.ok('Account status updated');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (company.isLoading) return <Spinner />;
  if (company.error) return <ErrorState error={company.error} />;
  const c = company.data!;
  const sub = c.subscription;
  return (
    <>
      <Link to="/admin/companies" className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" /> Companies
      </Link>
      <PageHeader
        title={c.name}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            {c.isDevFixture && <DevFixture />}
            {c.status === 'ACTIVE' ? <Badge tone="ok">Active</Badge> : <Badge tone="bad">{c.status}</Badge>}
            {c.email} · joined {fmtDate(c.createdAt)}
          </span>
        }
        actions={
          superAdmin && (
            <>
              <Button variant="outline" onClick={() => setGranting(true)}>
                Grant manual subscription
              </Button>
              {c.status === 'ACTIVE' ? (
                <Button variant="ghost" className="text-bad" onClick={() => setSuspendOpen(true)}>
                  Suspend
                </Button>
              ) : (
                <Button variant="outline" onClick={() => setStatus.mutate('ACTIVE')}>
                  Reactivate
                </Button>
              )}
            </>
          )
        }
      />
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label="Plan"
          value={sub.subscription?.planName ?? '—'}
          sub={<SubscriptionStatus status={sub.subscription?.status} source={sub.subscription?.source} />}
        />
        <Stat label="Period ends" value={sub.subscription ? fmtDate(sub.subscription.currentPeriodEnd) : '—'} />
        <Stat label="Screens" value={`${c.counts.screens} / ${sub.entitlements.max_screens ?? 0}`} />
        <Stat label="Playbacks this period" value={fmtNumber(sub.playsThisPeriod)} sub={`of ${fmtNumber(sub.entitlements.monthly_playback_allocation ?? 0)}`} />
      </div>
      <div className="space-y-6">
        <Card
          title="Establishments"
          padded={false}
          actions={
            superAdmin && (
              <Button size="sm" variant="outline" onClick={() => setEditingLoc('new')}>
                Add
              </Button>
            )
          }
        >
          {locations.data?.length ? (
            <Table>
              <tbody>
                {locations.data.map((l) => (
                  <tr key={l.id}>
                    <Td>
                      <div className="font-medium">{l.name}</div>
                      <div className="text-xs text-muted">
                        {l.streetAddress}
                        {l.eircode && `, ${l.eircode}`} · {l.zoneNames.join(', ') || 'no zones'}
                      </div>
                    </Td>
                    <Td>{l.participatesInNetwork ? <Badge tone="ok">Participating</Badge> : <Badge>Opted out</Badge>}</Td>
                    <Td className="tabular text-right">{l.screenCount} screens</Td>
                    {superAdmin && (
                      <Td className="text-right">
                        <Button size="sm" variant="ghost" onClick={() => setEditingLoc(l)}>
                          Edit
                        </Button>
                      </Td>
                    )}
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <p className="p-5 text-sm text-muted">No establishments.</p>
          )}
        </Card>
        <Card title="Screens" padded={false}>
          {screens.data?.length ? <ScreenTable screens={screens.data} /> : <p className="p-5 text-sm text-muted">No screens paired.</p>}
        </Card>
        <Card title="Campaigns" padded={false}>
          {campaigns.data?.items.length ? (
            <Table>
              <tbody>
                {campaigns.data.items.map((r) => (
                  <tr key={r.id} className="hover:bg-subtle/50">
                    <Td>
                      <Link to={`/admin/campaigns/${r.id}`} className="font-medium hover:underline">
                        {r.name}
                      </Link>
                    </Td>
                    <Td>
                      <CampaignStatus status={r.status} />
                    </Td>
                    <Td className="text-muted">
                      {fmtDate(r.startAt)} – {fmtDate(r.endAt)}
                    </Td>
                    <Td className="tabular text-right">{fmtNumber(r.playbackStarts)} plays</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <p className="p-5 text-sm text-muted">No campaigns.</p>
          )}
        </Card>
        <Card title="Users" padded={false}>
          <Table>
            <tbody>
              {users.data?.map((u) => (
                <tr key={u.id}>
                  <Td>
                    {u.fullName} <span className="text-muted">· {u.email}</span>
                  </Td>
                  <Td>{u.role}</Td>
                  <Td className="text-muted">last sign-in {fmtRelative(u.lastLoginAt)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
      <Dialog
        open={granting}
        onClose={() => setGranting(false)}
        title="Grant manual subscription"
        description="For pilots and development. Manual subscriptions grant entitlements but never count as revenue."
        footer={
          <Button onClick={() => doGrant.mutate()} loading={doGrant.isPending}>
            Grant
          </Button>
        }
      >
        <div className="space-y-4">
          <Field label="Plan" htmlFor="g-plan">
            <Select id="g-plan" value={grant.planCode} onChange={(e) => setGrant({ ...grant, planCode: e.target.value })}>
              {plans.data?.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.name} ({fmtEuro(p.monthlyPriceCents)}
                  {p.priceIsDraft ? ', draft price' : ''})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Length (days)" htmlFor="g-days">
            <Input
              id="g-days"
              type="number"
              min={1}
              max={366}
              value={grant.periodDays}
              onChange={(e) => setGrant({ ...grant, periodDays: Number(e.target.value) })}
            />
          </Field>
          <Field label="Reason (recorded in the audit log)" htmlFor="g-note">
            <Input id="g-note" value={grant.note} onChange={(e) => setGrant({ ...grant, note: e.target.value })} placeholder="e.g. Pilot agreement, Oct 2026" />
          </Field>
        </div>
      </Dialog>
      <ConfirmDialog
        open={suspendOpen}
        onClose={() => setSuspendOpen(false)}
        onConfirm={() => setStatus.mutate('SUSPENDED')}
        loading={setStatus.isPending}
        danger
        title="Suspend this company?"
        confirmLabel="Suspend"
      >
        Their adverts stop being distributed and their screens show only the holding slide until reactivated.
      </ConfirmDialog>
      <LocationDialog open={editingLoc !== null} onClose={() => setEditingLoc(null)} base={base} location={editingLoc === 'new' ? null : editingLoc} />
    </>
  );
}

// ---- Establishments ---------------------------------------------------------------------
export function AdminEstablishments() {
  const { data: me } = useMe();
  const q = useQuery({ queryKey: ['locations', 'all'], queryFn: () => api.get<Location[]>('/api/admin/locations') });
  const [rulesFor, setRulesFor] = useState<Location | null>(null);
  const [excludeFor, setExcludeFor] = useState<Location | null>(null);
  return (
    <>
      <PageHeader title="Establishments" description="All participating premises and their advertising rules." />
      <Card padded={false}>
        {q.isLoading ? (
          <Spinner />
        ) : !q.data?.length ? (
          <EmptyState icon={<Building2 className="size-6" />} title="No establishments yet" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Establishment</Th>
                <Th>Company</Th>
                <Th>Venue type</Th>
                <Th>Zones</Th>
                <Th>Rules</Th>
                <Th className="text-right">Screens</Th>
                {isSuperAdmin(me) && <Th />}
              </tr>
            </thead>
            <tbody>
              {q.data.map((l) => (
                <tr key={l.id}>
                  <Td>
                    <div className="font-medium">{l.name}</div>
                    <div className="text-xs text-muted">
                      {l.streetAddress}
                      {l.eircode && `, ${l.eircode}`}
                    </div>
                  </Td>
                  <Td>
                    <Link to={`/admin/companies/${l.companyId}`} className="hover:underline">
                      {l.companyName}
                    </Link>
                  </Td>
                  <Td className="text-muted">{l.categoryName ?? '—'}</Td>
                  <Td className="text-xs text-muted">{l.zoneNames.join(', ') || '—'}</Td>
                  <Td className="text-xs">
                    {!l.participatesInNetwork && <Badge>Opted out</Badge>}
                    {l.blockCategoryIds.length > 0 && <div>{l.blockCategoryIds.length} blocked categories</div>}
                    {l.allowCategoryIds.length > 0 && <div>allow-list of {l.allowCategoryIds.length}</div>}
                    {l.excludedCompanyIds.length > 0 && <div>{l.excludedCompanyIds.length} excluded advertisers</div>}
                  </Td>
                  <Td className="tabular text-right">{l.screenCount}</Td>
                  {isSuperAdmin(me) && (
                    <Td className="text-right whitespace-nowrap">
                      <Button size="sm" variant="ghost" onClick={() => setRulesFor(l)}>
                        Categories
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setExcludeFor(l)}>
                        Advertisers
                      </Button>
                    </Td>
                  )}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <RulesDialog open={rulesFor !== null} onClose={() => setRulesFor(null)} base={`/api/companies/${rulesFor?.companyId}`} location={rulesFor} />
      <AdvertiserExclusionsDialog location={excludeFor} onClose={() => setExcludeFor(null)} />
    </>
  );
}

function AdvertiserExclusionsDialog({ location, onClose }: { location: Location | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const companies = useQuery({
    queryKey: ['admin', 'companies', 'all'],
    queryFn: () => api.get<Paged<CompanyRow>>('/api/admin/companies?pageSize=100'),
    enabled: Boolean(location),
  });
  const [excluded, setExcluded] = useState<string[]>([]);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  if (location && loadedFor !== location.id) {
    setLoadedFor(location.id);
    setExcluded(location.excludedCompanyIds);
  }
  const save = useMutation({
    mutationFn: () =>
      api.put(`/api/companies/${location!.companyId}/locations/${location!.id}/rules`, {
        allowCategoryIds: location!.allowCategoryIds,
        blockCategoryIds: location!.blockCategoryIds,
        excludedCompanyIds: excluded,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['locations'] });
      toast.ok('Advertiser exclusions saved');
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog
      open={location !== null}
      onClose={onClose}
      title={`Excluded advertisers — ${location?.name ?? ''}`}
      description="Specific businesses whose adverts never play here."
      footer={
        <Button onClick={() => save.mutate()} loading={save.isPending}>
          Save
        </Button>
      }
    >
      <div className="space-y-2">
        {companies.data?.items
          .filter((c) => c.id !== location?.companyId)
          .map((c) => (
            <Checkbox
              key={c.id}
              label={c.name}
              checked={excluded.includes(c.id)}
              onChange={(on) => setExcluded(on ? [...excluded, c.id] : excluded.filter((x) => x !== c.id))}
            />
          ))}
      </div>
    </Dialog>
  );
}

// ---- Smart TVs ---------------------------------------------------------------------------
export function AdminScreens() {
  const { data: me } = useMe();
  const superAdmin = isSuperAdmin(me);
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['screens', 'all'], queryFn: () => api.get<Screen[]>('/api/admin/screens'), refetchInterval: 15_000 });
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Screen | null>(null);
  const [unpairing, setUnpairing] = useState(false);
  const command = useMutation({
    mutationFn: (type: string) => api.post(`/api/admin/screens/${selected!.id}/commands`, { type }),
    onSuccess: () => toast.ok('Command queued. The screen picks it up on its next heartbeat.'),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const status = useMutation({
    mutationFn: (s: 'ACTIVE' | 'DISABLED') => api.post(`/api/admin/screens/${selected!.id}/status`, { status: s }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['screens'] });
      setSelected(null);
      toast.ok('Screen updated');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const unpair = useMutation({
    mutationFn: () => api.post(`/api/admin/screens/${selected!.id}/unpair`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['screens'] });
      setUnpairing(false);
      setSelected(null);
      toast.ok('Screen unpaired and its credential revoked');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const rows = (q.data ?? []).filter((s) => !filter || (filter === 'attention' ? ['OFFLINE', 'ERROR', 'STALLED'].includes(s.health) : s.health === filter));
  return (
    <>
      <PageHeader
        title="Smart TVs"
        description="Every paired screen. Heartbeats arrive every 30 seconds; a screen is shown offline after 2 minutes without one."
      />
      <Card padded={false}>
        <div className="flex gap-2 border-b border-line p-3">
          <Select aria-label="Filter screens" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-56">
            <option value="">All screens</option>
            <option value="attention">Needs attention</option>
            <option value="PLAYING">Playback active</option>
            <option value="OFFLINE">Offline</option>
            <option value="NEVER_CONNECTED">Not connected yet</option>
            <option value="DISABLED">Disabled</option>
          </Select>
        </div>
        {q.isLoading ? (
          <Spinner />
        ) : !rows.length ? (
          <EmptyState icon={<MonitorPlay className="size-6" />} title="No screens match" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Screen</Th>
                <Th>Company</Th>
                <Th>Status</Th>
                <Th>Last heartbeat</Th>
                <Th>Playlist</Th>
                <Th>Player</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} className="cursor-pointer hover:bg-subtle/50" onClick={() => setSelected(s)}>
                  <Td>
                    <div className="font-medium">{s.displayName}</div>
                    <div className="text-xs text-muted">{s.locationName}</div>
                  </Td>
                  <Td>{s.companyName}</Td>
                  <Td>
                    <ScreenHealth health={s.health} />
                  </Td>
                  <Td className="text-muted">{fmtRelative(s.lastHeartbeatAt)}</Td>
                  <Td className="tabular text-xs text-muted">
                    {s.currentPlaylistVersion ?? '—'} / {s.latestPlaylistVersion ?? '—'}
                  </Td>
                  <Td className="text-xs text-muted">
                    {s.platform ?? '—'} {s.playerVersion && `· v${s.playerVersion}`}
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
        title={selected?.displayName ?? ''}
        description={selected ? `${selected.locationName} · ${selected.companyName}` : ''}
      >
        {selected && (
          <div className="space-y-6">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-3">
              {(
                [
                  ['Status', <ScreenHealth key="h" health={selected.health} />],
                  ['Last heartbeat', fmtDateTime(selected.lastHeartbeatAt)],
                  ['Last playlist sync', fmtDateTime(selected.lastPlaylistSyncAt)],
                  ['Last playback', fmtDateTime(selected.lastPlaybackAt)],
                  ['Registered', fmtDate(selected.registeredAt)],
                  ['Resolution', selected.resolution ?? '—'],
                  ['Video support', selected.supportsVideo === null ? 'Not reported' : selected.supportsVideo ? 'Yes' : 'No'],
                  ['Platform', selected.platform ?? '—'],
                  ['Player version', selected.playerVersion ?? '—'],
                ] as const
              ).map(([k, v]) => (
                <div key={k}>
                  <dt className="text-xs text-muted">{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            {selected.lastError && (
              <Notice tone="bad" title={`Last error · ${fmtDateTime(selected.lastErrorAt)}`}>
                {selected.lastError}
              </Notice>
            )}
            {selected.userAgent && <p className="font-mono text-[11px] break-all text-muted">{selected.userAgent}</p>}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => command.mutate('REFRESH_PLAYLIST')}>
                <RefreshCw className="size-3.5" /> Refresh playlist
              </Button>
              <Button size="sm" variant="outline" onClick={() => command.mutate('REFRESH_CONFIG')}>
                Refresh configuration
              </Button>
              <Button size="sm" variant="outline" onClick={() => command.mutate('RELOAD_PLAYER')}>
                Reload player
              </Button>
              <Button size="sm" variant="outline" onClick={() => command.mutate('REPORT_DIAGNOSTICS')}>
                Request diagnostics
              </Button>
              {superAdmin &&
                (selected.status === 'ACTIVE' ? (
                  <Button size="sm" variant="ghost" onClick={() => status.mutate('DISABLED')}>
                    Disable screen
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => status.mutate('ACTIVE')}>
                    Enable screen
                  </Button>
                ))}
              {superAdmin && (
                <Button size="sm" variant="ghost" className="text-bad" onClick={() => setUnpairing(true)}>
                  Unpair
                </Button>
              )}
            </div>
            <p className="text-xs text-muted">A browser player can reload itself but cannot power the TV on or off.</p>
            <PlaylistPanel url={`/api/admin/network/screens/${selected.id}/playlist`} />
          </div>
        )}
      </Dialog>
      <ConfirmDialog
        open={unpairing}
        onClose={() => setUnpairing(false)}
        onConfirm={() => unpair.mutate()}
        loading={unpair.isPending}
        danger
        title="Unpair this screen?"
        confirmLabel="Unpair"
      >
        Its device credential is revoked immediately. The business can pair it again with a new code.
      </ConfirmDialog>
    </>
  );
}
