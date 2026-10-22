import { fmtNumber } from '@/lib/format';

/** Minimal accessible bar chart (SVG). Values are shown in a visually hidden table for screen readers. */
export function BarChart({
  data,
  series,
  height = 180,
}: {
  data: Array<Record<string, string | number>>;
  series: Array<{ key: string; label: string; className: string }>;
  height?: number;
}) {
  const labelKey = 'day' in (data[0] ?? {}) ? 'day' : Object.keys(data[0] ?? { label: '' })[0]!;
  const max = Math.max(1, ...data.flatMap((d) => series.map((s) => Number(d[s.key] ?? 0))));
  const n = data.length || 1;
  const groupW = 100 / n;
  const barW = (groupW * 0.7) / series.length;
  return (
    <figure>
      <svg viewBox={`0 0 100 ${height / 3}`} preserveAspectRatio="none" className="w-full" style={{ height }} aria-hidden>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1="0" x2="100" y1={(height / 3) * f} y2={(height / 3) * f} className="stroke-line" strokeWidth="0.15" />
        ))}
        {data.map((d, i) =>
          series.map((s, j) => {
            const v = Number(d[s.key] ?? 0);
            const h = (v / max) * (height / 3 - 1);
            return (
              <rect
                key={`${i}-${s.key}`}
                x={i * groupW + groupW * 0.15 + j * barW}
                y={height / 3 - h}
                width={barW * 0.92}
                height={h}
                rx="0.4"
                className={s.className}
              />
            );
          }),
        )}
      </svg>
      <div className="mt-2 flex justify-between text-[11px] text-muted tabular">
        <span>{String(data[0]?.[labelKey] ?? '')}</span>
        <span>{String(data[data.length - 1]?.[labelKey] ?? '')}</span>
      </div>
      <figcaption className="mt-2 flex gap-4 text-xs text-muted">
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <svg className="size-2.5" aria-hidden>
              <rect width="10" height="10" rx="2" className={s.className} />
            </svg>
            {s.label}
          </span>
        ))}
        <span className="ml-auto">max {fmtNumber(max)}</span>
      </figcaption>
      <table className="sr-only">
        <thead>
          <tr>
            <th>{labelKey}</th>
            {series.map((s) => (
              <th key={s.key}>{s.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((d, i) => (
            <tr key={i}>
              <td>{String(d[labelKey])}</td>
              {series.map((s) => (
                <td key={s.key}>{String(d[s.key] ?? 0)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** Horizontal bars for category breakdowns. */
export function BarList({ rows, valueKey, labelKey }: { rows: Array<Record<string, unknown>>; valueKey: string; labelKey: string }) {
  const max = Math.max(1, ...rows.map((r) => Number(r[valueKey] ?? 0)));
  if (!rows.length) return <p className="py-6 text-center text-sm text-muted">No playback recorded in this period.</p>;
  return (
    <ul className="space-y-2">
      {rows.map((r, i) => (
        <li key={i}>
          <div className="mb-1 flex justify-between text-[13px]">
            <span className="truncate">{String(r[labelKey])}</span>
            <span className="tabular text-muted">{fmtNumber(Number(r[valueKey]))}</span>
          </div>
          <div className="h-1.5 rounded-full bg-subtle">
            <div className="h-1.5 rounded-full bg-accent" style={{ width: `${(Number(r[valueKey]) / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
