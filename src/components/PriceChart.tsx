'use client';

import { useMemo, useState, type PointerEvent } from 'react';
import { ui } from '@/components/ui';
import { stepIndexAt } from '@/lib/chart';
import { pct } from '@/lib/format';
import { barOrder, MAX_BAR_OUTCOMES, paletteSlot, TIER_HEX } from '@/lib/headline';

export interface ChartPoint {
  at: string;
  prices: number[];
}

const COLORS = ['#1d1d1d', '#b31b1b', '#2f6db3', '#8a6d1f', '#5b8a3a', '#7a4b9a'];

/** Three or four outcomes are ordered best first and drawn in the tier colours of the outcome bar. */
function colorOf(i: number, n: number): string {
  return n > 2 && n <= MAX_BAR_OUTCOMES ? TIER_HEX[paletteSlot(i, n)] : COLORS[i % COLORS.length];
}

/**
 * The price timeline: every outcome's price after every fill, against time.
 * A binary market draws only its first outcome (the other is the complement).
 * SVG, server-rendered; on the client, hovering shows a line with the time
 * and every price then, and hovering a legend entry fades the other lines.
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
  const [hoverX, setHoverX] = useState<number | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const times = useMemo(() => points.map((p) => new Date(p.at).getTime()), [points]);
  const n = labels.length;
  // Binary: the first outcome only. Ordered outcomes: worst first, like the bar.
  const lines = n === 2 ? [0] : n <= MAX_BAR_OUTCOMES ? barOrder(n) : labels.map((_, i) => i);
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
    points.map((p, k) => (k === 0 ? `M${x(p.at)},${y(p.prices[i])}` : `H${x(p.at)}V${y(p.prices[i])}`)).join('') +
    `H${width - pad.r}`;

  const ticks = [0.25, 0.5, 0.75].filter((v) => v > lo && v < hi);
  // Days for a long history, clock times for one that fits in a day.
  const short = t1 - t0 < 86_400_000;
  const date = (ms: number) =>
    new Date(ms).toLocaleString('en-GB', {
      timeZone: 'UTC',
      ...(short ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short' }),
    }) + (short ? ' UTC' : '');
  const when = (ms: number) =>
    new Date(ms).toLocaleString('en-GB', {
      timeZone: 'UTC',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }) + ' UTC';

  // The pointer, in viewBox units, held to the plot area.
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const vx = ((e.clientX - r.left) / r.width) * width;
    setHoverX(Math.min(Math.max(vx, pad.l), width - pad.r));
  };
  const hoverMs = hoverX === null ? null : t0 + ((hoverX - pad.l) / (width - pad.l - pad.r)) * (t1 - t0);
  const at = hoverMs === null ? null : points[stepIndexAt(times, hoverMs)];
  // Best first in the readout, the way the outcomes are listed.
  const readout = [...lines].reverse();
  const faded = (i: number) => focus !== null && focus !== i;

  return (
    <div>
      <div className="relative">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width="100%"
          role="img"
          aria-label="price history"
          className="touch-pan-y"
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setHoverX(null)}
        >
          {ticks.map((v) => (
            <g key={v}>
              <line x1={pad.l} x2={width - pad.r} y1={y(v)} y2={y(v)} stroke="#ddd" strokeDasharray="3 4" />
              <text x={0} y={y(v) + 4} fontSize="11" fill="#999" fontFamily="ui-monospace, monospace">
                {pct(v)}
              </text>
            </g>
          ))}
          {lines.map((i) => (
            <path
              key={i}
              d={path(i)}
              fill="none"
              stroke={colorOf(i, n)}
              strokeWidth={focus === i ? 2.6 : 1.8}
              opacity={faded(i) ? 0.15 : 1}
              className="transition-opacity"
            />
          ))}
          {/* The focused line on top of the others. */}
          {focus !== null && lines.includes(focus) && (
            <path d={path(focus)} fill="none" stroke={colorOf(focus, n)} strokeWidth="2.6" pointerEvents="none" />
          )}
          {hoverX !== null && at && (
            <g pointerEvents="none">
              <line x1={hoverX} x2={hoverX} y1={pad.t} y2={height - pad.b} stroke="#999" strokeDasharray="2 3" />
              {lines.map((i) => (
                <circle
                  key={i}
                  cx={hoverX}
                  cy={y(at.prices[i])}
                  r="3.5"
                  fill={colorOf(i, n)}
                  stroke="#fbfaf7"
                  strokeWidth="1.5"
                  opacity={faded(i) ? 0.15 : 1}
                />
              ))}
            </g>
          )}
          <text x={pad.l} y={height - 4} fontSize="11" fill="#999" fontFamily="ui-monospace, monospace">
            {date(t0)}
          </text>
          <text
            x={width - pad.r}
            y={height - 4}
            fontSize="11"
            fill="#999"
            textAnchor="end"
            fontFamily="ui-monospace, monospace"
          >
            {date(t1)}
          </text>
        </svg>
        {hoverX !== null && hoverMs !== null && at && (
          <div
            className={`pointer-events-none absolute top-1 border border-rule bg-card px-2 py-1 font-mono text-xs whitespace-nowrap shadow-sm ${
              hoverX > width * 0.6 ? '-translate-x-full -ml-2' : 'ml-2'
            }`}
            style={{ left: `${(hoverX / width) * 100}%` }}
          >
            <div className="text-muted">{when(hoverMs)}</div>
            {readout.map((i) => (
              <div key={i} className={faded(i) ? 'opacity-40' : focus === i ? 'font-bold' : ''}>
                <span style={{ color: colorOf(i, n) }}>━</span> {labels[i]} {pct(at.prices[i])}
              </div>
            ))}
          </div>
        )}
      </div>
      {lines.length > 1 && (
        <div className={ui.caption}>
          {lines.map((i) => (
            <span
              key={i}
              tabIndex={0}
              className={`mr-3.5 cursor-default transition-opacity ${faded(i) ? 'opacity-40' : ''} ${focus === i ? 'text-ink' : ''}`}
              onPointerEnter={() => setFocus(i)}
              onPointerLeave={() => setFocus(null)}
              onFocus={() => setFocus(i)}
              onBlur={() => setFocus(null)}
            >
              <span style={{ color: colorOf(i, n) }}>━</span> {labels[i]}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
