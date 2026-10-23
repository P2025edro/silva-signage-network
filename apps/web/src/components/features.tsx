import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Film, ImageIcon, Upload } from 'lucide-react';
import { api, errorMessage, fieldErrors } from '@/lib/api';
import { useEnvInfo } from '@/lib/env';
import { fmtDateTime, fmtDuration } from '@/lib/format';
import type { Location, Media, PlaylistView, Ref } from '@/lib/types';
import { REASON_LABELS } from './status';
import { useToast } from './toast';
import { Badge, Button, Checkbox, Dialog, EmptyState, Field, Input, Notice, Select, Spinner, Table, Td, Th } from './ui';

/**
 * Large phone photos can exceed the host's request limit. Shrink them in the browser first;
 * the server still validates and re-encodes everything it receives.
 */
async function fitImage(file: File, maxBytes: number): Promise<File> {
  if (!file.type.startsWith('image/') || file.size <= maxBytes) return file;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 3840 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  for (const q of [0.9, 0.8, 0.7]) {
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', q));
    if (blob && blob.size <= maxBytes) return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
  }
  return file;
}

export const useZones = () => useQuery({ queryKey: ['zones'], queryFn: () => api.get<Ref[]>('/api/zones'), staleTime: 300_000 });
export const useCategories = () => useQuery({ queryKey: ['categories'], queryFn: () => api.get<Ref[]>('/api/categories'), staleTime: 300_000 });

// ---- Location form -------------------------------------------------------------
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
type Hours = Record<(typeof DAY_KEYS)[number], { closed: boolean; open: string; close: string }>;

function hoursFrom(loc?: Location | null): { recorded: boolean; hours: Hours } {
  const hours = Object.fromEntries(DAY_KEYS.map((d) => [d, { closed: false, open: '09:00', close: '18:00' }])) as Hours;
  if (!loc?.openingHours) return { recorded: false, hours };
  for (const d of DAY_KEYS) {
    const i = loc.openingHours[d]?.[0];
    hours[d] = i ? { closed: false, open: i.open, close: i.close } : { ...hours[d], closed: true };
  }
  return { recorded: true, hours };
}

export function LocationDialog({ open, onClose, base, location }: { open: boolean; onClose: () => void; base: string; location?: Location | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: zones } = useZones();
  const { data: categories } = useCategories();
  const [form, setForm] = useState(() => init(location));
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (open) {
      setForm(init(location));
      setErrors({});
    }
  }, [open, location]);

  function init(l?: Location | null) {
    const h = hoursFrom(l);
    return {
      name: l?.name ?? '',
      streetAddress: l?.streetAddress ?? '',
      eircode: l?.eircode ?? '',
      city: l?.city ?? 'Dublin',
      neighbourhood: l?.neighbourhood ?? '',
      categoryId: l?.categoryId ?? '',
      participatesInNetwork: l?.participatesInNetwork ?? true,
      zoneIds: l?.zoneIds ?? ([] as string[]),
      hoursRecorded: h.recorded,
      hours: h.hours,
      latitude: l?.latitude ?? null,
      longitude: l?.longitude ?? null,
      coordinatesVerified: l?.coordinatesVerified ?? false,
    };
  }

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name,
        streetAddress: form.streetAddress,
        eircode: form.eircode || null,
        city: form.city,
        neighbourhood: form.neighbourhood || null,
        categoryId: form.categoryId || null,
        participatesInNetwork: form.participatesInNetwork,
        zoneIds: form.zoneIds,
        openingHours: form.hoursRecorded
          ? Object.fromEntries(DAY_KEYS.map((d) => [d, form.hours[d].closed ? [] : [{ open: form.hours[d].open, close: form.hours[d].close }]]))
          : null,
        latitude: form.latitude,
        longitude: form.longitude,
        coordinatesVerified: form.coordinatesVerified,
      };
      return location ? api.put(`${base}/locations/${location.id}`, body) : api.post(`${base}/locations`, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['locations'] });
      toast.ok(location ? 'Establishment updated' : 'Establishment added');
      onClose();
    },
    onError: (e) => {
      setErrors(fieldErrors(e));
      toast.error(errorMessage(e));
    },
  });

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={location ? 'Edit establishment' : 'Add establishment'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <Field label="Establishment name" htmlFor="loc-name" error={errors.name} className="sm:col-span-2">
          <Input id="loc-name" value={form.name} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field label="Street address" htmlFor="loc-street" error={errors.streetAddress} className="sm:col-span-2">
          <Input id="loc-street" value={form.streetAddress} onChange={(e) => set('streetAddress', e.target.value)} />
        </Field>
        <Field label="Eircode" htmlFor="loc-eircode" error={errors.eircode}>
          <Input id="loc-eircode" value={form.eircode} onChange={(e) => set('eircode', e.target.value.toUpperCase())} placeholder="D08 XY12" />
        </Field>
        <Field label="Neighbourhood" htmlFor="loc-nb">
          <Input id="loc-nb" value={form.neighbourhood} onChange={(e) => set('neighbourhood', e.target.value)} placeholder="Portobello" />
        </Field>
        <Field label="City" htmlFor="loc-city" error={errors.city}>
          <Input id="loc-city" value={form.city} onChange={(e) => set('city', e.target.value)} />
        </Field>
        <Field label="Venue type" htmlFor="loc-cat" hint="Used by advertisers' targeting and competition rules.">
          <Select id="loc-cat" value={form.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
            <option value="">Not specified</option>
            {categories?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <fieldset className="sm:col-span-2">
          <legend className="mb-2 text-[13px] font-medium">Advertising zones</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {zones?.map((z) => (
              <Checkbox
                key={z.id}
                label={z.name}
                checked={form.zoneIds.includes(z.id)}
                onChange={(on) => set('zoneIds', on ? [...form.zoneIds, z.id] : form.zoneIds.filter((x) => x !== z.id))}
              />
            ))}
          </div>
        </fieldset>
        <div className="sm:col-span-2">
          <Checkbox
            label="Show network adverts from other businesses on screens here"
            checked={form.participatesInNetwork}
            onChange={(v) => set('participatesInNetwork', v)}
          />
        </div>
        <fieldset className="sm:col-span-2">
          <legend className="mb-2 text-[13px] font-medium">Opening hours</legend>
          <Checkbox label="Only show adverts during opening hours" checked={form.hoursRecorded} onChange={(v) => set('hoursRecorded', v)} />
          {form.hoursRecorded && (
            <div className="mt-3 space-y-2">
              {DAY_KEYS.map((d, i) => (
                <div key={d} className="grid grid-cols-[100px_auto_1fr_1fr] items-center gap-3 text-sm">
                  <span>{DAY_NAMES[i]}</span>
                  <Checkbox
                    label="Closed"
                    checked={form.hours[d].closed}
                    onChange={(v) => set('hours', { ...form.hours, [d]: { ...form.hours[d], closed: v } })}
                  />
                  <Input
                    type="time"
                    step={900}
                    aria-label={`${DAY_NAMES[i]} opens`}
                    disabled={form.hours[d].closed}
                    value={form.hours[d].open}
                    onChange={(e) => set('hours', { ...form.hours, [d]: { ...form.hours[d], open: e.target.value } })}
                  />
                  <Input
                    type="time"
                    step={900}
                    aria-label={`${DAY_NAMES[i]} closes`}
                    disabled={form.hours[d].closed}
                    value={form.hours[d].close}
                    onChange={(e) => set('hours', { ...form.hours, [d]: { ...form.hours[d], close: e.target.value } })}
                  />
                </div>
              ))}
              <p className="text-xs text-muted">If closing is earlier than opening, the hours run past midnight.</p>
            </div>
          )}
        </fieldset>
        {location?.coordinatesVerified && (
          <p className="text-xs text-muted sm:col-span-2">
            Verified coordinates: {location.latitude}, {location.longitude}
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

// ---- Competition rules ------------------------------------------------------------
export function RulesDialog({ open, onClose, base, location }: { open: boolean; onClose: () => void; base: string; location: Location | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: categories } = useCategories();
  const [block, setBlock] = useState<string[]>([]);
  const [allow, setAllow] = useState<string[]>([]);
  useEffect(() => {
    if (open && location) {
      setBlock(location.blockCategoryIds);
      setAllow(location.allowCategoryIds);
    }
  }, [open, location]);
  const save = useMutation({
    mutationFn: () =>
      api.put(`${base}/locations/${location!.id}/rules`, {
        blockCategoryIds: block,
        allowCategoryIds: allow,
        excludedCompanyIds: location!.excludedCompanyIds,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['locations'] });
      toast.ok('Advertising rules saved. Playlists have been updated.');
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!location) return null;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Advertising rules — ${location.name}`}
      description="Choose which kinds of business may advertise on your screens."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            Save rules
          </Button>
        </>
      }
    >
      <Table>
        <thead>
          <tr>
            <Th>Business category</Th>
            <Th className="text-center">Block</Th>
            <Th className="text-center">Only allow</Th>
          </tr>
        </thead>
        <tbody>
          {categories?.map((c) => (
            <tr key={c.id}>
              <Td>{c.name}</Td>
              <Td className="text-center">
                <input
                  type="checkbox"
                  aria-label={`Block ${c.name}`}
                  className="size-4 accent-[var(--bad)]"
                  checked={block.includes(c.id)}
                  onChange={(e) => {
                    setBlock(e.target.checked ? [...block, c.id] : block.filter((x) => x !== c.id));
                    if (e.target.checked) setAllow(allow.filter((x) => x !== c.id));
                  }}
                />
              </Td>
              <Td className="text-center">
                <input
                  type="checkbox"
                  aria-label={`Only allow ${c.name}`}
                  className="size-4 accent-[var(--accent)]"
                  checked={allow.includes(c.id)}
                  onChange={(e) => {
                    setAllow(e.target.checked ? [...allow, c.id] : allow.filter((x) => x !== c.id));
                    if (e.target.checked) setBlock(block.filter((x) => x !== c.id));
                  }}
                />
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      <p className="mt-3 text-xs text-muted">If any category is marked "Only allow", adverts from all other categories are left out. Blocks always win.</p>
    </Dialog>
  );
}

// ---- Pair screen ---------------------------------------------------------------
export function PairScreenDialog({ open, onClose, base, locations }: { open: boolean; onClose: () => void; base: string; locations: Location[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [code, setCode] = useState('');
  const [locationId, setLocationId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setCode('');
      setDisplayName('');
      setError(null);
      setLocationId(locations[0]?.id ?? '');
    }
  }, [open, locations]);
  const pair = useMutation({
    mutationFn: () => api.post(`${base}/screens/pair`, { code, locationId, displayName }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['screens'] });
      toast.ok('Screen paired. It will start playing within a few seconds.');
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Pair a Smart TV"
      description="Open the Silva player on the TV's web browser. It shows an 8-character code."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => pair.mutate()}
            loading={pair.isPending}
            disabled={code.replace(/\W/g, '').length !== 8 || !locationId || displayName.trim().length < 2}
          >
            Pair screen
          </Button>
        </>
      }
    >
      {locations.length === 0 ? (
        <Notice tone="warn">Add an establishment first — every screen belongs to one.</Notice>
      ) : (
        <div className="space-y-4">
          {error && <Notice tone="bad">{error}</Notice>}
          <Field label="Code shown on the TV" htmlFor="pair-code">
            <Input
              id="pair-code"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="ABCD-EFGH"
              className="tabular font-mono text-lg tracking-widest"
              autoComplete="off"
            />
          </Field>
          <Field label="Establishment" htmlFor="pair-loc">
            <Select id="pair-loc" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Screen name" htmlFor="pair-name" hint="So you can tell screens apart, e.g. “Waiting area”.">
            <Input id="pair-name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </Field>
        </div>
      )}
    </Dialog>
  );
}

// ---- Playlist panel --------------------------------------------------------------
export function PlaylistPanel({ url }: { url: string }) {
  const { data, isLoading } = useQuery({ queryKey: ['playlist', url], queryFn: () => api.get<PlaylistView>(url) });
  if (isLoading || !data) return <Spinner />;
  return (
    <div className="space-y-5">
      {data.screenReasons?.length > 0 && (
        <Notice tone="warn" title="This screen isn't receiving adverts">
          {data.screenReasons.map((r) => REASON_LABELS[r] ?? r).join(' · ')}
        </Notice>
      )}
      <div>
        <div className="mb-2 flex items-baseline justify-between">
          <h3 className="text-sm font-semibold">Current loop {data.version ? `· v${data.version}` : ''}</h3>
          {data.validUntil && <span className="text-xs text-muted">Refreshes by {fmtDateTime(data.validUntil)}</span>}
        </div>
        {data.items.length === 0 ? (
          <p className="rounded-md bg-subtle px-4 py-6 text-center text-sm text-muted">
            Nothing scheduled. The screen shows the Silva Signage Network holding slide.
          </p>
        ) : (
          <ol className="divide-y divide-line rounded-md border border-line">
            {data.items.map((i) => (
              <li key={i.position} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="tabular w-5 text-xs text-muted">{i.position + 1}</span>
                {i.kind === 'VIDEO' ? <Film className="size-4 text-muted" /> : <ImageIcon className="size-4 text-muted" />}
                <span className="flex-1 truncate">
                  {i.campaignName} <span className="text-muted">· {i.advertiserName}</span>
                </span>
                <span className="tabular text-xs text-muted">{i.durationSec}s</span>
              </li>
            ))}
          </ol>
        )}
      </div>
      {data.decisions.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">Why each campaign is or isn't here</h3>
          <Table className="rounded-md border border-line">
            <thead>
              <tr>
                <Th>Campaign</Th>
                <Th>Slots</Th>
                <Th>Reason</Th>
              </tr>
            </thead>
            <tbody>
              {data.decisions.map((d) => (
                <tr key={d.campaignId}>
                  <Td>
                    {d.campaignName} <span className="text-muted">· {d.advertiserName}</span>
                  </Td>
                  <Td className="tabular">{d.slots}</Td>
                  <Td>
                    {d.eligible ? (
                      d.displacedByCapacity ? (
                        <Badge tone="warn">Eligible, loop full</Badge>
                      ) : (
                        <Badge tone="ok">Included</Badge>
                      )
                    ) : (
                      <span className="text-xs text-muted">{d.reasons.map((r) => REASON_LABELS[r] ?? r).join(' · ')}</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </div>
  );
}

// ---- Media ---------------------------------------------------------------------
export function MediaThumb({ m, className = 'h-16 w-28' }: { m: Pick<Media, 'thumbnailUrl' | 'kind' | 'originalFilename'>; className?: string }) {
  return (
    <div className={`relative shrink-0 overflow-hidden rounded bg-subtle ${className}`}>
      {m.thumbnailUrl ? <img src={m.thumbnailUrl} alt={m.originalFilename} className="size-full object-cover" loading="lazy" /> : null}
      {m.kind === 'VIDEO' && (
        <span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 text-[10px] font-medium text-white">
          <Film className="inline size-3" /> video
        </span>
      )}
    </div>
  );
}

export function MediaUploadButton({ base, onUploaded }: { base: string; onUploaded?: (m: Media) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const env = useEnvInfo();
  const video = env.data?.videoUploads !== false;
  const up = useMutation({
    mutationFn: async (file: File) => {
      const maxVideo = env.data?.maxVideoBytes;
      if (file.type.startsWith('video/') && maxVideo && file.size > maxVideo)
        throw new Error(`This video is ${(file.size / 1048576).toFixed(1)} MB. The limit here is ${(maxVideo / 1048576).toFixed(0)} MB — export a shorter or smaller H.264 MP4.`);
      return api.upload<Media>(`${base}/media`, env.data?.maxImageBytes ? await fitImage(file, env.data.maxImageBytes) : file);
    },
    onSuccess: (m) => {
      qc.invalidateQueries({ queryKey: ['media'] });
      toast.ok('Upload processed and ready');
      onUploaded?.(m);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={video ? 'image/jpeg,image/png,image/webp,video/mp4' : 'image/jpeg,image/png,image/webp'}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) up.mutate(f);
          e.target.value = '';
        }}
      />
      <Button variant="outline" onClick={() => input.current?.click()} loading={up.isPending}>
        <Upload className="size-4" /> {up.isPending ? 'Processing…' : video ? 'Upload image or video' : 'Upload image'}
      </Button>
    </>
  );
}

export function MediaLibrary({ base }: { base: string }) {
  const env = useEnvInfo();
  const { data, isLoading } = useQuery({ queryKey: ['media', base], queryFn: () => api.get<Media[]>(`${base}/media`) });
  if (isLoading) return <Spinner />;
  if (!data?.length)
    return (
      <EmptyState icon={<ImageIcon className="size-6" />} title="No media yet" action={<MediaUploadButton base={base} />}>
        {env.data?.videoUploads === false
          ? 'JPEG, PNG or WebP. Images are fitted to 1080p for TVs.'
          : 'JPEG, PNG, WebP or MP4. Images are fitted to 1080p; videos are converted to a TV-friendly format.'}
      </EmptyState>
    );
  return (
    <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {data.map((m) => (
        <li key={m.id} className="rounded-md border border-line p-2">
          <MediaThumb m={m} className="aspect-video w-full" />
          <div className="mt-2 truncate text-xs font-medium" title={m.originalFilename}>
            {m.originalFilename}
          </div>
          <div className="text-[11px] text-muted">
            {m.width}×{m.height}
            {m.kind === 'VIDEO' && ` · ${fmtDuration(m.durationMs)}`}
          </div>
        </li>
      ))}
    </ul>
  );
}
