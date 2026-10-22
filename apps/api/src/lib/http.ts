import { z } from 'zod';

export const uuid = z.string().uuid();
export const CompanyParams = z.object({ companyId: uuid });

export const Pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  search: z.string().trim().max(100).optional(),
});

export const offsetOf = (p: { page: number; pageSize: number }) => (p.page - 1) * p.pageSize;

export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

/** Irish Eircode, e.g. D08 XY12. */
export const eircode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^(?:[AC-FHKNPRTV-Y]\d{2}|D6W) ?[0-9AC-FHKNPRTV-Y]{4}$/, 'Enter a valid Eircode')
  .nullish()
  .transform((v) => v || null);

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = value instanceof Date ? value.toISOString() : String(value);
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows].map((r) => r.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}
