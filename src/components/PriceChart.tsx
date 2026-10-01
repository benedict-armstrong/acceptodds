'use client';

import { useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { ui } from '@/components/ui';
import { stepIndexAt } from '@/lib/chart';
import { clock, dayMonth, pct } from '@/lib/format';
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
 * Drawn at the width it is given, measured, never scaled to fit: scaled down
 * to a phone, its labels would shrink to a few pixels.
 */
export function PriceChart({
  points,
  labels,
  caption,
}: {
  points: ChartPoint[];
  labels: string[];
  caption: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(820);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Less tall on a phone, but not in proportion: a plot must stay readable.
  const height = width < 500 ? 180 : 220;
  const [focus, setFocus] = useState<number | null>(null);
  const times = useMemo(() => points.map((p) => new Date(p.at).getTime()), [points]);
  const n = labels.length;
  // Binary: the first outcome only. Ordered outcomes: worst first, like the bar.
  const lines = n === 2 ? [0] : n <= MAX_BAR_OUTCOMES ? barOrder(n) : labels.map((_, i) => i);
  // Two axes. By default fills are spaced evenly, not by the clock: trades come
  // in bursts, and on a time axis a few fills hours apart are long flat runs and
  // sheer cliffs. The clock then shows at the two ends and in the hover readout.
  // The linear one is true to time, and starts just before the first fill so the
  // stretch before anyone traded does not squeeze the history.
  const [linear, setLinear] = useState(false);
  const tEnd = times[times.length - 1];
  const t0 = linear && points.length > 1 ? times[1] - Math.max((tEnd - times[1]) * 0.1, 60_000) : times[0];
  const t1 = Math.max(tEnd, t0 + 1);
  const last = Math.max(points.length - 1, 1);
  const all = points.flatMap((p) => lines.map((i) => p.prices[i]));
  const lo = Math.max(0, Math.min(...all) - 0.08);
  const hi = Math.min(1, Math.max(...all) + 0.08);
  const pad = { l: 36, r: 8, t: 8, b: 20 };
  const span = width - pad.l - pad.r;
  const xk = (k: number) => pad.l + (linear ? Math.max(times[k] - t0, 0) / (t1 - t0) : k / last) * span;
  const y = (p: number) => pad.t + (1 - (p - lo) / (hi - lo)) * (height - pad.t - pad.b);

  // Even: straight lines from fill to fill. Linear: a price holds until the next
  // fill, except the opening to the first fill, which is a slope, not a price
  // that held. Flat to the edge after the last.
  const path = (i: number) =>
    points
      .map((p, k) => {
        const yy = y(p.prices[i]);
        if (k === 0) return `M${xk(k)},${yy}`;
        return linear && k > 1 ? `H${xk(k)}V${yy}` : `L${xk(k)},${yy}`;
      })
      .join('') + `H${width - pad.r}`;

  const ticks = [0.25, 0.5, 0.75].filter((v) => v > lo && v < hi);
  // Days for a long history, clock times for one that fits in a day.
  const short = t1 - t0 < 86_400_000;
  const date = (ms: number) => (short ? `${clock(ms)} UTC` : dayMonth(ms));
  const when = (ms: number) => `${dayMonth(ms)}, ${clock(ms)} UTC`;

  // Even: the pointer snaps to the nearest fill. Linear: it reads the price in force.
  const [hoverPx, setHoverPx] = useState<number | null>(null);
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const vx = ((e.clientX - r.left) / r.width) * width;
    setHoverPx(Math.min(Math.max(vx, pad.l), width - pad.r));
  };
  const frac = hoverPx === null ? null : (hoverPx - pad.l) / span;
  const hoverK =
    frac === null
      ? null
      : linear
        ? stepIndexAt(times, t0 + frac * (t1 - t0))
        : Math.min(Math.max(Math.round(frac * last), 0), points.length - 1);
  const hoverX = hoverK === null ? null : linear ? hoverPx : xk(hoverK);
  const hoverMs = hoverK === null || frac === null ? null : linear ? t0 + frac * (t1 - t0) : times[hoverK];
  const at = hoverK === null ? null : points[hoverK];
  // Best first in the readout, the way the outcomes are listed.
  const readout = [...lines].reverse();
  const faded = (i: number) => focus !== null && focus !== i;

  return (
    <div>
      <div ref={box} className="relative">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width="100%"
          role="img"
          aria-label="price history"
          className="touch-pan-y"
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={() => setHoverPx(null)}
        >
          {ticks.map((v) => (
            <g key={v}>
              <line x1={pad.l} x2={width - pad.r} y1={y(v)} y2={y(v)} strokeDasharray="3 4" className="stroke-rule" />
              <text x={0} y={y(v) + 4} className="fill-muted font-mono text-[11px]">
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
              <line
                x1={hoverX}
                x2={hoverX}
                y1={pad.t}
                y2={height - pad.b}
                strokeDasharray="2 3"
                className="stroke-faint"
              />
              {lines.map((i) => (
                <circle
                  key={i}
                  cx={hoverX}
                  cy={y(at.prices[i])}
                  r="3.5"
                  fill={colorOf(i, n)}
                  className="stroke-bg"
                  strokeWidth="1.5"
                  opacity={faded(i) ? 0.15 : 1}
                />
              ))}
            </g>
          )}
          <text x={pad.l} y={height - 4} className="fill-muted font-mono text-[11px]">
            {date(t0)}
          </text>
          <text x={width - pad.r} y={height - 4} textAnchor="end" className="fill-muted font-mono text-[11px]">
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
        <div className={`${ui.caption} text-right`}>
          {lines.map((i) => (
            <span
              key={i}
              tabIndex={0}
              className={`ml-3.5 cursor-default transition-opacity ${faded(i) ? 'opacity-40' : ''} ${focus === i ? 'text-ink' : ''}`}
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
      <div className={ui.caption}>
        {caption}{' '}
        <button type="button" className="cursor-pointer text-muted hover:underline" onClick={() => setLinear(!linear)}>
          {linear ? 'space by trade' : 'space by time'}
        </button>
      </div>
    </div>
  );
}
