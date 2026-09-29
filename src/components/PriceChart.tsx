import { ui } from '@/components/ui';
import { pct } from '@/lib/format';

export interface ChartPoint {
  at: string;
  prices: number[];
}

const COLORS = ['#1d1d1d', '#b31b1b', '#2f6db3', '#8a6d1f', '#5b8a3a', '#7a4b9a'];

/**
 * The price timeline: every outcome's price after every fill, against time.
 * A binary market draws only its first outcome (the other is the complement).
 * Pure SVG, so it renders on the server and the client alike.
 */
export function PriceChart({
  points,
  labels,
  width = 820,
  height = 220,
}: {
  points: ChartPoint[];
  labels: string[];
  width?: number;
  height?: number;
}) {
  const lines = labels.length === 2 ? [0] : labels.map((_, i) => i);
  const t0 = new Date(points[0].at).getTime();
  const t1 = Math.max(new Date(points[points.length - 1].at).getTime(), t0 + 1);
  const all = points.flatMap((p) => lines.map((i) => p.prices[i]));
  const lo = Math.max(0, Math.min(...all) - 0.08);
  const hi = Math.min(1, Math.max(...all) + 0.08);
  const pad = { l: 36, r: 8, t: 8, b: 20 };
  const x = (at: string) => pad.l + ((new Date(at).getTime() - t0) / (t1 - t0)) * (width - pad.l - pad.r);
  const y = (p: number) => pad.t + (1 - (p - lo) / (hi - lo)) * (height - pad.t - pad.b);

  // Step line: a price holds until the next fill changes it.
  const path = (i: number) =>
    points
      .map((p, k) => (k === 0 ? `M${x(p.at)},${y(p.prices[i])}` : `H${x(p.at)}V${y(p.prices[i])}`))
      .join('') + `H${width - pad.r}`;

  const ticks = [0.25, 0.5, 0.75].filter((v) => v > lo && v < hi);
  // Days for a long history, clock times for one that fits in a day.
  const short = t1 - t0 < 86_400_000;
  const date = (ms: number) =>
    new Date(ms).toLocaleString('en-GB', {
      timeZone: 'UTC',
      ...(short ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short' }),
    }) + (short ? ' UTC' : '');

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label="price history">
        {ticks.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={width - pad.r} y1={y(v)} y2={y(v)} stroke="#ddd" strokeDasharray="3 4" />
            <text x={0} y={y(v) + 4} fontSize="11" fill="#999" fontFamily="ui-monospace, monospace">
              {pct(v)}
            </text>
          </g>
        ))}
        {lines.map((i) => (
          <path key={i} d={path(i)} fill="none" stroke={COLORS[i % COLORS.length]} strokeWidth="1.8" />
        ))}
        <text x={pad.l} y={height - 4} fontSize="11" fill="#999" fontFamily="ui-monospace, monospace">
          {date(t0)}
        </text>
        <text x={width - pad.r} y={height - 4} fontSize="11" fill="#999" textAnchor="end" fontFamily="ui-monospace, monospace">
          {date(t1)}
        </text>
      </svg>
      {lines.length > 1 && (
        <div className={ui.caption}>
          {lines.map((i) => (
            <span key={i} className="mr-3.5">
              <span style={{ color: COLORS[i % COLORS.length] }}>━</span> {labels[i]}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
