import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Inbox } from 'lucide-react';
import { api, errorMessage } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useToast } from '@/components/toast';
import { Badge, Button, Card, Dialog, EmptyState, Field, PageHeader, Select, Spinner, Table, Td, Textarea, Th, type Tone } from '@/components/ui';

interface Lead {
  id: string;
  businessName: string;
  contactName: string;
  email: string;
  phone: string | null;
  area: string | null;
  businessType: string | null;
  screensEstimate: number | null;
  interestedPlan: string | null;
  message: string | null;
  status: string;
  notes: string | null;
  createdAt: string;
}

const STATUS: Record<string, [Tone, string]> = {
  NEW: ['accent', 'New'],
  CONTACTED: ['info', 'Contacted'],
  DEMO_BOOKED: ['warn', 'Visit booked'],
  WON: ['ok', 'Won'],
  LOST: ['neutral', 'Lost'],
};

export function AdminLeads() {
  const qc = useQueryClient();
  const toast = useToast();
  const [filter, setFilter] = useState('');
  const q = useQuery({ queryKey: ['admin', 'leads', filter], queryFn: () => api.get<Lead[]>(`/api/admin/leads${filter ? `?status=${filter}` : ''}`), refetchInterval: 60_000 });
  const [open, setOpen] = useState<Lead | null>(null);
  const [draft, setDraft] = useState({ status: 'NEW', notes: '' });
  const save = useMutation({
    mutationFn: () => api.patch(`/api/admin/leads/${open!.id}`, { status: draft.status, notes: draft.notes || null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin'] });
      setOpen(null);
      toast.ok('Enquiry updated');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <>
      <PageHeader title="Enquiries" description="Businesses that asked for a setup visit through the website." />
      <Card padded={false}>
        <div className="border-b border-line p-3">
          <Select aria-label="Filter by status" value={filter} onChange={(e) => setFilter(e.target.value)} className="w-48">
            <option value="">All enquiries</option>
            {Object.entries(STATUS).map(([k, [, l]]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </Select>
        </div>
        {q.isLoading ? (
          <Spinner />
        ) : !q.data?.length ? (
          <EmptyState icon={<Inbox className="size-6" />} title="No enquiries yet">
            New requests from the website’s “Book a free setup visit” form appear here.
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Business</Th>
                <Th>Contact</Th>
                <Th>Details</Th>
                <Th>Status</Th>
                <Th>Received</Th>
              </tr>
            </thead>
            <tbody>
              {q.data.map((l) => (
                <tr
                  key={l.id}
                  className="cursor-pointer hover:bg-subtle/50"
                  onClick={() => {
                    setOpen(l);
                    setDraft({ status: l.status, notes: l.notes ?? '' });
                  }}
                >
                  <Td>
                    <div className="font-medium">{l.businessName}</div>
                    <div className="text-xs text-muted">{[l.businessType, l.area].filter(Boolean).join(' · ')}</div>
                  </Td>
                  <Td>
                    <div>{l.contactName}</div>
                    <div className="text-xs text-muted">{l.email}</div>
                  </Td>
                  <Td className="text-xs text-muted">
                    {l.screensEstimate !== null && `${l.screensEstimate} TV${l.screensEstimate === 1 ? '' : 's'}`}
                    {l.interestedPlan && l.interestedPlan !== 'not-sure' && ` · ${l.interestedPlan}`}
                  </Td>
                  <Td>
                    <Badge tone={STATUS[l.status]?.[0] ?? 'neutral'}>{STATUS[l.status]?.[1] ?? l.status}</Badge>
                  </Td>
                  <Td className="text-muted">{fmtDateTime(l.createdAt)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <Dialog
        open={open !== null}
        onClose={() => setOpen(null)}
        title={open?.businessName ?? ''}
        description={open ? `Received ${fmtDateTime(open.createdAt)}` : ''}
        footer={
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            Save
          </Button>
        }
      >
        {open && (
          <div className="space-y-4 text-sm">
            <dl className="grid grid-cols-[120px_1fr] gap-y-1.5">
              <dt className="text-muted">Contact</dt>
              <dd>{open.contactName}</dd>
              <dt className="text-muted">Email</dt>
              <dd>
                <a href={`mailto:${open.email}`} className="text-accent hover:underline">
                  {open.email}
                </a>
              </dd>
              {open.phone && (
                <>
                  <dt className="text-muted">Phone</dt>
                  <dd>
                    <a href={`tel:${open.phone.replace(/\s/g, '')}`} className="text-accent hover:underline">
                      {open.phone}
                    </a>
                  </dd>
                </>
              )}
              <dt className="text-muted">Area</dt>
              <dd>{open.area ?? '—'}</dd>
              <dt className="text-muted">Business type</dt>
              <dd>{open.businessType ?? '—'}</dd>
              <dt className="text-muted">TVs</dt>
              <dd>{open.screensEstimate ?? '—'}</dd>
              <dt className="text-muted">Plan</dt>
              <dd>{open.interestedPlan ?? '—'}</dd>
            </dl>
            {open.message && <p className="rounded-md bg-subtle p-3 whitespace-pre-line">{open.message}</p>}
            <Field label="Status" htmlFor="lead-status">
              <Select id="lead-status" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
                {Object.entries(STATUS).map(([k, [, l]]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Notes" htmlFor="lead-notes">
              <Textarea id="lead-notes" value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
            </Field>
          </div>
        )}
      </Dialog>
    </>
  );
}
