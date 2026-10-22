import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowLeft, Download, GripVertical, Trash2 } from 'lucide-react';
import { api, apiUrl, errorMessage } from '@/lib/api';
import { useCompany } from '@/lib/auth';
import { DAYS, fmtDate, fmtDateTime, fmtNumber, fromLocalInput, hhmmToMinutes, minutesToHHMM, toLocalInput } from '@/lib/format';
import type { CampaignDetail, Capacity, Media, Paged, CampaignRow } from '@/lib/types';
import { BarChart, BarList } from '@/components/charts';
import { MediaThumb, MediaUploadButton, useCategories, useZones } from '@/components/features';
import { CampaignStatus } from '@/components/status';
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
  Select,
  Spinner,
  Stat,
  Table,
  Td,
  Textarea,
  Th,
} from '@/components/ui';

// ---- Editor ---------------------------------------------------------------------
const FormSchema = z
  .object({
    name: z.string().trim().min(2, 'Give the campaign a name').max(120),
    description: z.string().max(1000).optional(),
    start: z.string().min(1, 'Choose a start'),
    end: z.string().min(1, 'Choose an end'),
    requestedPlaysPerDay: z.string().regex(/^\d*$/, 'Whole number').optional(),
    useSchedule: z.boolean(),
    days: z.array(z.number()),
    from: z.string(),
    to: z.string(),
  })
  .refine((v) => !v.start || !v.end || v.end > v.start, { path: ['end'], message: 'End must be after start' })
  .refine((v) => !v.useSchedule || v.days.length > 0, { path: ['days'], message: 'Pick at least one day' })
  .refine((v) => !v.useSchedule || v.to > v.from, { path: ['to'], message: 'Must be after the start time' })
  .refine((v) => !v.useSchedule || (hhmmToMinutes(v.from) % 15 === 0 && hhmmToMinutes(v.to) % 15 === 0), { path: ['from'], message: 'Use 15-minute steps' });
type FormValues = z.infer<typeof FormSchema>;

export function CampaignEditor() {
  const { campaignId } = useParams();
  const { base } = useCompany();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const existing = useQuery({
    queryKey: ['campaign', campaignId],
    queryFn: () => api.get<CampaignDetail>(`${base}/campaigns/${campaignId}`),
    enabled: Boolean(campaignId),
  });
  const library = useQuery({ queryKey: ['media', base], queryFn: () => api.get<Media[]>(`${base}/media`) });
  const { data: zones } = useZones();
  const { data: categories } = useCategories();

  const [media, setMedia] = useState<Array<{ mediaAssetId: string; displaySeconds: number }>>([]);
  const [zoneIds, setZoneIds] = useState<string[]>([]);
  const [targetCats, setTargetCats] = useState<string[]>([]);
  const [excludedCats, setExcludedCats] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);

  // Default: start as soon as approved (current quarter hour), run for two weeks.
  const startDefault = useMemo(() => new Date(Math.floor(Date.now() / 900_000) * 900_000), []);
  const form = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      name: '',
      description: '',
      start: toLocalInput(startDefault),
      end: toLocalInput(new Date(startDefault.getTime() + 14 * 86_400_000)),
      requestedPlaysPerDay: '',
      useSchedule: false,
      days: [1, 2, 3, 4, 5, 6, 7],
      from: '09:00',
      to: '18:00',
    },
  });

  useEffect(() => {
    const c = existing.data;
    if (!c) return;
    form.reset({
      name: c.name,
      description: c.description ?? '',
      start: toLocalInput(c.startAt),
      end: toLocalInput(c.endAt),
      requestedPlaysPerDay: c.requestedPlaysPerDay ? String(c.requestedPlaysPerDay) : '',
      useSchedule: Boolean(c.schedule),
      days: c.schedule?.days ?? [1, 2, 3, 4, 5, 6, 7],
      from: c.schedule ? minutesToHHMM(c.schedule.startMinute) : '09:00',
      to: c.schedule ? minutesToHHMM(c.schedule.endMinute) : '18:00',
    });
    setMedia(c.media.map((m) => ({ mediaAssetId: m.id, displaySeconds: m.displaySeconds ?? 15 })));
    setZoneIds(c.targetZoneIds);
    setTargetCats(c.targetCategoryIds);
    setExcludedCats(c.excludedCategoryIds);
  }, [existing.data, form]);

  const save = useMutation({
    mutationFn: (v: FormValues) => {
      const body = {
        name: v.name,
        description: v.description || null,
        startAt: fromLocalInput(v.start),
        endAt: fromLocalInput(v.end),
        requestedPlaysPerDay: v.requestedPlaysPerDay ? Number(v.requestedPlaysPerDay) : null,
        schedule: v.useSchedule
          ? { days: [...v.days].sort(), startMinute: hhmmToMinutes(v.from), endMinute: v.to === '24:00' ? 1440 : hhmmToMinutes(v.to) }
          : null,
        targetZoneIds: zoneIds,
        targetCategoryIds: targetCats,
        excludedCategoryIds: excludedCats,
        media,
      };
      return campaignId
        ? api.put<{ ok: true }>(`${base}/campaigns/${campaignId}`, body).then(() => ({ id: campaignId }))
        : api.post<{ id: string }>(`${base}/campaigns`, body);
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['campaigns'] });
      qc.invalidateQueries({ queryKey: ['campaign', r.id] });
      toast.ok('Campaign saved as a draft');
      nav(`/portal/campaigns/${r.id}`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (campaignId && existing.isLoading) return <Spinner />;
  if (existing.data && !['DRAFT', 'CHANGES_REQUESTED'].includes(existing.data.status)) {
    return <Notice tone="warn">This campaign has been submitted and can no longer be edited.</Notice>;
  }
  const byId = new Map((library.data ?? []).map((m) => [m.id, m]));
  const errs = form.formState.errors;
  const useSchedule = form.watch('useSchedule');
  const days = form.watch('days');

  return (
    <>
      <Link
        to={campaignId ? `/portal/campaigns/${campaignId}` : '/portal/campaigns'}
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-ink"
      >
        <ArrowLeft className="size-4" /> Back
      </Link>
      <PageHeader
        title={campaignId ? 'Edit campaign' : 'New campaign'}
        description="Saved as a draft. You can submit it for Silva Solutions approval from the campaign page."
      />
      {existing.data?.status === 'CHANGES_REQUESTED' && existing.data.reviewNote && (
        <div className="mb-6">
          <Notice tone="warn" title="Changes requested by Silva Solutions">
            {existing.data.reviewNote}
          </Notice>
        </div>
      )}
      <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="space-y-6">
        <Card title="Details">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Campaign name" htmlFor="c-name" error={errs.name?.message} className="sm:col-span-2">
              <Input id="c-name" {...form.register('name')} aria-invalid={Boolean(errs.name)} />
            </Field>
            <Field label="Description (internal)" htmlFor="c-desc" className="sm:col-span-2">
              <Textarea id="c-desc" {...form.register('description')} />
            </Field>
            <Field label="Starts (Dublin time)" htmlFor="c-start" error={errs.start?.message} hint="It can only go live once approved.">
              <Input id="c-start" type="datetime-local" step={900} {...form.register('start')} />
            </Field>
            <Field label="Ends (Dublin time)" htmlFor="c-end" error={errs.end?.message}>
              <Input id="c-end" type="datetime-local" step={900} {...form.register('end')} />
            </Field>
            <Field
              label="Requested plays per day (optional)"
              htmlFor="c-ppd"
              error={errs.requestedPlaysPerDay?.message}
              hint="Used to show whether the network can deliver what you'd like. Not a guarantee."
            >
              <Input id="c-ppd" inputMode="numeric" {...form.register('requestedPlaysPerDay')} />
            </Field>
          </div>
        </Card>

        <Card
          title="Creatives"
          actions={
            <>
              <MediaUploadButton base={base} onUploaded={(m) => setMedia((x) => [...x, { mediaAssetId: m.id, displaySeconds: 15 }])} />
              <Button type="button" variant="outline" onClick={() => setPicking(true)}>
                Choose from library
              </Button>
            </>
          }
        >
          {media.length === 0 ? (
            <p className="text-sm text-muted">
              Add at least one image or video (16:9, 1920×1080 recommended). Images show for the time you set; videos play in full.
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {media.map((m, i) => {
                const asset = byId.get(m.mediaAssetId);
                return (
                  <li key={m.mediaAssetId} className="flex items-center gap-4 py-3">
                    <GripVertical className="size-4 text-muted" aria-hidden />
                    {asset && <MediaThumb m={asset} />}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{asset?.originalFilename ?? 'Media'}</div>
                      <div className="text-xs text-muted">{asset?.kind === 'VIDEO' ? `Video · ${((asset.durationMs ?? 0) / 1000).toFixed(0)} s` : 'Image'}</div>
                    </div>
                    {asset?.kind !== 'VIDEO' && (
                      <label className="flex items-center gap-2 text-xs text-muted">
                        Show for
                        <Select
                          className="w-20"
                          value={m.displaySeconds}
                          onChange={(e) => setMedia(media.map((x, j) => (j === i ? { ...x, displaySeconds: Number(e.target.value) } : x)))}
                        >
                          {[5, 10, 15, 20, 30].map((s) => (
                            <option key={s} value={s}>
                              {s}s
                            </option>
                          ))}
                        </Select>
                      </label>
                    )}
                    <Button type="button" size="sm" variant="ghost" aria-label="Move up" disabled={i === 0} onClick={() => setMedia(swap(media, i, i - 1))}>
                      ↑
                    </Button>
                    <Button type="button" size="sm" variant="ghost" aria-label="Remove" onClick={() => setMedia(media.filter((_, j) => j !== i))}>
                      <Trash2 className="size-4" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title="Where it runs">
          <div className="space-y-5">
            <fieldset>
              <legend className="mb-2 text-[13px] font-medium">Zones</legend>
              <p className="mb-2 text-xs text-muted">Leave all unticked to run in any zone. Your plan limits how many zones a campaign may target.</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {zones?.map((z) => (
                  <Checkbox
                    key={z.id}
                    label={z.name}
                    checked={zoneIds.includes(z.id)}
                    onChange={(on) => setZoneIds(on ? [...zoneIds, z.id] : zoneIds.filter((x) => x !== z.id))}
                  />
                ))}
              </div>
            </fieldset>
            <div className="grid gap-5 sm:grid-cols-2">
              <fieldset>
                <legend className="mb-2 text-[13px] font-medium">Only at these types of venue</legend>
                <div className="space-y-1.5">
                  {categories?.map((c) => (
                    <Checkbox
                      key={c.id}
                      label={c.name}
                      checked={targetCats.includes(c.id)}
                      onChange={(on) => setTargetCats(on ? [...targetCats, c.id] : targetCats.filter((x) => x !== c.id))}
                    />
                  ))}
                </div>
              </fieldset>
              <fieldset>
                <legend className="mb-2 text-[13px] font-medium">Never at these types of venue</legend>
                <div className="space-y-1.5">
                  {categories?.map((c) => (
                    <Checkbox
                      key={c.id}
                      label={c.name}
                      checked={excludedCats.includes(c.id)}
                      onChange={(on) => setExcludedCats(on ? [...excludedCats, c.id] : excludedCats.filter((x) => x !== c.id))}
                    />
                  ))}
                </div>
              </fieldset>
            </div>
          </div>
        </Card>

        <Card title="When it runs">
          <Checkbox label="Only at certain times" checked={useSchedule} onChange={(v) => form.setValue('useSchedule', v)} />
          {useSchedule && (
            <div className="mt-4 space-y-4">
              <div className="flex flex-wrap gap-2" role="group" aria-label="Days">
                {DAYS.map((d, i) => {
                  const iso = i + 1;
                  const on = days.includes(iso);
                  return (
                    <button
                      type="button"
                      key={d}
                      aria-pressed={on}
                      onClick={() => form.setValue('days', on ? days.filter((x) => x !== iso) : [...days, iso], { shouldValidate: true })}
                      className={`h-8 w-12 rounded-md border text-sm ${on ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted'}`}
                    >
                      {d}
                    </button>
                  );
                })}
              </div>
              {errs.days && <p className="text-xs text-bad">{errs.days.message}</p>}
              <div className="flex gap-4">
                <Field label="From" htmlFor="c-from" error={errs.from?.message}>
                  <Input id="c-from" type="time" step={900} {...form.register('from')} />
                </Field>
                <Field label="Until" htmlFor="c-to" error={errs.to?.message}>
                  <Input id="c-to" type="time" step={900} {...form.register('to')} />
                </Field>
              </div>
              <p className="text-xs text-muted">
                Times are Dublin local time and follow summer/winter clock changes. Adverts also only run while each venue is open.
              </p>
            </div>
          )}
        </Card>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => nav(-1)}>
            Cancel
          </Button>
          <Button type="submit" loading={save.isPending}>
            Save draft
          </Button>
        </div>
      </form>

      <Dialog open={picking} onClose={() => setPicking(false)} wide title="Choose media">
        {!library.data?.length ? (
          <EmptyState title="Your library is empty">Upload an image or video first.</EmptyState>
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {library.data.map((m) => {
              const chosen = media.some((x) => x.mediaAssetId === m.id);
              return (
                <li key={m.id}>
                  <button
                    type="button"
                    className={`w-full rounded-md border p-2 text-left ${chosen ? 'border-accent ring-2 ring-accent/30' : 'border-line hover:border-muted'}`}
                    onClick={() => setMedia(chosen ? media.filter((x) => x.mediaAssetId !== m.id) : [...media, { mediaAssetId: m.id, displaySeconds: 15 }])}
                  >
                    <MediaThumb m={m} className="aspect-video w-full" />
                    <div className="mt-1 truncate text-xs">{m.originalFilename}</div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Dialog>
    </>
  );
}

const swap = <T,>(a: T[], i: number, j: number) => {
  const b = [...a];
  [b[i], b[j]] = [b[j]!, b[i]!];
  return b;
};

// ---- Detail ------------------------------------------------------------------------
interface Report {
  totals: { scheduled: number; started: number; completed: number; failed: number };
  byLocation: Array<{ location: string; host: string; screen: string; starts: number; completions: number; failures: number }>;
  byZone: Array<{ zone: string; starts: number; completions: number }>;
  byDay: Array<{ day: string; starts: number; completions: number; failures: number }>;
  quota: { allocation: number; usedThisPeriod: number; periodEnd: string | null };
  capacity: Capacity;
  note: string;
  period: { from: string; to: string };
}

export function CampaignReport({ base, campaignId }: { base: string; campaignId: string }) {
  const { data, isLoading, error } = useQuery({ queryKey: ['report', campaignId], queryFn: () => api.get<Report>(`${base}/campaigns/${campaignId}/report`) });
  if (isLoading) return <Spinner />;
  if (error || !data) return <ErrorState error={error} />;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Playback starts" value={fmtNumber(data.totals.started)} sub="last 30 days" />
        <Stat label="Reported completions" value={fmtNumber(data.totals.completed)} />
        <Stat label="Playback failures" value={fmtNumber(data.totals.failed)} tone={data.totals.failed ? 'warn' : undefined} />
        <Stat label="Allocation used" value={`${fmtNumber(data.quota.usedThisPeriod)}`} sub={`of ${fmtNumber(data.quota.allocation)} this period`} />
      </div>
      <Card
        title="Daily playback"
        actions={
          <a href={apiUrl(`${base}/campaigns/${campaignId}/report.csv`)} className="inline-flex items-center gap-1 text-xs text-muted hover:text-ink">
            <Download className="size-3.5" /> CSV
          </a>
        }
      >
        {data.byDay.length ? (
          <BarChart
            data={data.byDay}
            series={[
              { key: 'starts', label: 'Starts', className: 'fill-accent' },
              { key: 'failures', label: 'Failures', className: 'fill-bad' },
            ]}
          />
        ) : (
          <p className="py-6 text-center text-sm text-muted">No playback reported yet.</p>
        )}
      </Card>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="By zone">
          <BarList rows={data.byZone} valueKey="starts" labelKey="zone" />
        </Card>
        <Card title="Delivery outlook">
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted">Screens currently carrying this campaign</dt>
              <dd className="tabular">{data.capacity.screens.length}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted">Estimated plays today</dt>
              <dd className="tabular">{fmtNumber(data.capacity.estimatedPerDay)}</dd>
            </div>
            {data.capacity.requestedPerDay !== null && (
              <div className="flex justify-between">
                <dt className="text-muted">Requested per day</dt>
                <dd className="tabular">{fmtNumber(data.capacity.requestedPerDay)}</dd>
              </div>
            )}
          </dl>
          {data.capacity.shortfallPerDay > 0 && (
            <div className="mt-3">
              <Notice tone="warn" title="The network can't currently meet your request">
                About {fmtNumber(data.capacity.shortfallPerDay)} plays per day short. More participating screens in your target zones would close the gap.
              </Notice>
            </div>
          )}
          <p className="mt-3 text-xs text-muted">Estimates assume screens are on during opening hours.</p>
        </Card>
      </div>
      <Card title="By location" padded={false}>
        {data.byLocation.length ? (
          <Table>
            <thead>
              <tr>
                <Th>Location</Th>
                <Th>Screen</Th>
                <Th className="text-right">Starts</Th>
                <Th className="text-right">Completions</Th>
                <Th className="text-right">Failures</Th>
              </tr>
            </thead>
            <tbody>
              {data.byLocation.map((r, i) => (
                <tr key={i}>
                  <Td>
                    {r.location} <span className="text-muted">· {r.host}</span>
                  </Td>
                  <Td>{r.screen}</Td>
                  <Td className="tabular text-right">{fmtNumber(r.starts)}</Td>
                  <Td className="tabular text-right">{fmtNumber(r.completions)}</Td>
                  <Td className="tabular text-right">{fmtNumber(r.failures)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="p-5 text-sm text-muted">No playback reported yet.</p>
        )}
      </Card>
      <p className="text-xs text-muted">{data.note}</p>
    </div>
  );
}

export function PortalCampaignDetail() {
  const { campaignId } = useParams();
  const { base, isOwner } = useCompany();
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const {
    data: c,
    isLoading,
    error,
    refetch,
  } = useQuery({ queryKey: ['campaign', campaignId], queryFn: () => api.get<CampaignDetail>(`${base}/campaigns/${campaignId}`) });
  const [confirm, setConfirm] = useState<'SUBMIT' | 'PAUSE' | 'RESUME' | 'CANCEL' | 'DELETE' | null>(null);
  const act = useMutation({
    mutationFn: (action: string) =>
      action === 'DELETE' ? api.del(`${base}/campaigns/${campaignId}`) : api.post(`${base}/campaigns/${campaignId}/actions`, { action }),
    onSuccess: (_r, action) => {
      setConfirm(null);
      qc.invalidateQueries({ queryKey: ['campaigns'] });
      if (action === 'DELETE') return nav('/portal/campaigns');
      qc.invalidateQueries({ queryKey: ['campaign', campaignId] });
      toast.ok({ SUBMIT: 'Submitted for approval', PAUSE: 'Campaign paused', RESUME: 'Campaign resumed', CANCEL: 'Campaign cancelled' }[action] ?? 'Done');
    },
    onError: (e) => {
      setConfirm(null);
      toast.error(errorMessage(e));
    },
  });
  if (isLoading) return <Spinner />;
  if (error || !c) return <ErrorState error={error} retry={refetch} />;
  const editable = ['DRAFT', 'CHANGES_REQUESTED'].includes(c.status);
  const confirmText: Record<string, [string, string]> = {
    SUBMIT: [
      'Submit for approval?',
      'Silva Solutions will review the campaign before it is distributed. You won’t be able to edit it while it is under review.',
    ],
    PAUSE: ['Pause this campaign?', 'It will be removed from screens the next time they sync (usually within a minute).'],
    RESUME: ['Resume this campaign?', 'It will return to eligible screens.'],
    CANCEL: ['Cancel this campaign?', 'It will stop running and cannot be restarted.'],
    DELETE: ['Delete this draft?', 'This cannot be undone.'],
  };
  return (
    <>
      <Link to="/portal/campaigns" className="mb-4 inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ArrowLeft className="size-4" /> Campaigns
      </Link>
      <PageHeader
        title={c.name}
        description={
          <span className="inline-flex flex-wrap items-center gap-2">
            <CampaignStatus status={c.status} /> {fmtDateTime(c.startAt)} – {fmtDateTime(c.endAt)}
          </span>
        }
        actions={
          <>
            {editable && (
              <>
                <Link to={`/portal/campaigns/${c.id}/edit`}>
                  <Button variant="outline">Edit</Button>
                </Link>
                {c.status === 'DRAFT' && (
                  <Button variant="ghost" onClick={() => setConfirm('DELETE')}>
                    Delete
                  </Button>
                )}
                {isOwner && <Button onClick={() => setConfirm('SUBMIT')}>Submit for approval</Button>}
              </>
            )}
            {isOwner && ['SCHEDULED', 'ACTIVE'].includes(c.status) && (
              <Button variant="outline" onClick={() => setConfirm('PAUSE')}>
                Pause
              </Button>
            )}
            {isOwner && c.status === 'PAUSED' && <Button onClick={() => setConfirm('RESUME')}>Resume</Button>}
            {isOwner && ['SUBMITTED', 'UNDER_REVIEW', 'SCHEDULED', 'ACTIVE', 'PAUSED'].includes(c.status) && (
              <Button variant="ghost" className="text-bad" onClick={() => setConfirm('CANCEL')}>
                Cancel campaign
              </Button>
            )}
          </>
        }
      />
      {editable && !isOwner && (
        <div className="mb-6">
          <Notice>Only an account owner can submit campaigns for approval.</Notice>
        </div>
      )}
      {c.status === 'CHANGES_REQUESTED' && c.reviewNote && (
        <div className="mb-6">
          <Notice tone="warn" title="Changes requested">
            {c.reviewNote}
          </Notice>
        </div>
      )}
      {c.status === 'REJECTED' && c.reviewNote && (
        <div className="mb-6">
          <Notice tone="bad" title="Rejected">
            {c.reviewNote}
          </Notice>
        </div>
      )}
      <div className="mb-6 grid gap-6 lg:grid-cols-3">
        <Card title="Creatives" className="lg:col-span-2">
          {c.media.length ? (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {c.media.map((m) => (
                <li key={m.id}>
                  <a href={m.previewUrl} target="_blank" rel="noreferrer">
                    <MediaThumb m={m} className="aspect-video w-full" />
                  </a>
                  <div className="mt-1 text-xs text-muted">
                    {m.kind === 'VIDEO' ? `Video · ${((m.durationMs ?? 0) / 1000).toFixed(0)}s` : `Image · ${m.displaySeconds}s`}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">No creatives yet.</p>
          )}
        </Card>
        <Card title="History">
          {c.reviews.length ? (
            <ol className="space-y-3 text-sm">
              {c.reviews.map((r, i) => (
                <li key={i}>
                  <div>
                    <CampaignStatus status={r.toStatus} /> <span className="text-xs text-muted">by {r.byName}</span>
                  </div>
                  {r.reason && <div className="mt-1 text-xs text-muted">“{r.reason}”</div>}
                  <div className="text-xs text-muted">{fmtDateTime(r.createdAt)}</div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-muted">Not submitted yet.</p>
          )}
        </Card>
      </div>
      {!editable && <CampaignReport base={base} campaignId={c.id} />}
      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={() => act.mutate(confirm!)}
        loading={act.isPending}
        title={confirm ? confirmText[confirm]![0] : ''}
        danger={confirm === 'CANCEL' || confirm === 'DELETE'}
      >
        {confirm ? confirmText[confirm]![1] : ''}
      </ConfirmDialog>
    </>
  );
}

export function PortalReports() {
  const { base } = useCompany();
  const { data } = useQuery({
    queryKey: ['campaigns', base, 'reportable'],
    queryFn: () => api.get<Paged<CampaignRow>>(`${base}/campaigns?pageSize=100&status=SCHEDULED,ACTIVE,PAUSED,COMPLETED,CANCELLED`),
  });
  const [selected, setSelected] = useState('');
  const id = selected || data?.items[0]?.id;
  return (
    <>
      <PageHeader
        title="Reports"
        description="Playback reported by screens across the network."
        actions={
          data?.items.length ? (
            <Select aria-label="Campaign" value={id} onChange={(e) => setSelected(e.target.value)} className="w-72">
              {data.items.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({fmtDate(c.startAt)})
                </option>
              ))}
            </Select>
          ) : null
        }
      />
      {id ? (
        <CampaignReport base={base} campaignId={id} />
      ) : (
        <Card>
          <EmptyState title="No campaign has run yet">Reports appear once a campaign has been approved.</EmptyState>
        </Card>
      )}
      <p className="mt-4 text-xs text-muted">
        <Badge>Note</Badge> Silva Signage Network does not estimate audience size or impressions and does not collect any information about viewers.
      </p>
    </>
  );
}
