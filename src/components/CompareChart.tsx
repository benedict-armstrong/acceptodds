'use client';

import { useEffect, useRef, useState } from 'react';
import { SERIES } from '@/lib/compare';
import { countBelow, niceTicks } from '@/lib/distribution';
import { REP } from '@/lib/format';

const HEIGHT = 210;
/** Two rows of mean labels above the plot, one per series, so they never collide. */
const PAD = { top: 42, right: 12, bottom: 26, left: 12 };
const LABEL_ROW = 15;

function units(x: number): string {
  return Math.round(x).toLocaleString('en');
}

/**
 * Two fields' net worths overlaid (`/leaderboard/compare`): each one's kernel
 * density, translucent so the overlap shows, on one axis and one scale
 * (`lib/compare.sharedDensities`), and a dashed line at each field's mean,
 * labelled in its own row above the plot. Hover (or arrow keys) reads off how
 * many of each field have less. The legend is the caller's: it names the series.
 */
export function CompareChart({
  domain,
  series,
}: {
  /** In units. */
  domain: [number, number];
  /** At most two, in `SERIES` order. */
  series: {
    name: string;
    /** Evenly spaced across `domain`, on the shared scale; empty draws nothing. */
    curve: number[];
    /** Sorted ascending, in units: the hover counts. */
    values: number[];
    /** In units; null for an empty field. */
    mean: number | null;
  }[];
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const height = HEIGHT;
  const top = PAD.top;
  const plotW = width - PAD.left - PAD.right;
  const plotH = height - top - PAD.bottom;
  const span = domain[1] - domain[0] || 1;
  const sx = (x: number) => PAD.left + ((x - domain[0]) / span) * plotW;
  const sy = (y: number) => top + plotH - y * plotH;
  const base = top + plotH;
  const invert = (px: number) => domain[0] + ((px - PAD.left) / plotW) * span;
  const ticks = niceTicks(domain[0], domain[1], Math.max(2, Math.floor(plotW / 140)));
  const anchorAt = (x: number) => (x < width * 0.2 ? 'start' : x > width * 0.8 ? 'end' : 'middle');

  const paths = series.map((s) => {
    if (s.curve.length < 2) return null;
    const n = s.curve.length - 1;
    const line = s.curve
      .map((y, i) => `${i ? 'L' : 'M'}${sx(domain[0] + (span * i) / n).toFixed(1)},${sy(y).toFixed(1)}`)
      .join('');
    return { line, area: `${line}L${sx(domain[1]).toFixed(1)},${base}L${sx(domain[0]).toFixed(1)},${base}Z` };
  });
  const hoverX = hover === null ? null : sx(hover);

  return (
    <div ref={box} className="relative mt-2 select-none">
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`Net worth of ${series.map((s) => s.name).join(' and ')}`}
        tabIndex={0}
        className="block overflow-visible focus:outline-none"
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const x = invert(e.clientX - r.left);
          setHover(x >= domain[0] && x <= domain[1] ? x : null);
        }}
        onPointerLeave={() => setHover(null)}
        onBlur={() => setHover(null)}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
          e.preventDefault();
          const step = span / 40;
          const from = hover ?? (domain[0] + domain[1]) / 2;
          setHover(Math.min(domain[1], Math.max(domain[0], from + (e.key === 'ArrowLeft' ? -step : step))));
        }}
      >
        {paths.map((p, k) => p && <path key={`a${k}`} d={p.area} className={`${SERIES[k].fill} opacity-15`} />)}
        {paths.map(
          (p, k) =>
            p && (
              <path
                key={`l${k}`}
                d={p.line}
                fill="none"
                strokeWidth={2}
                strokeLinejoin="round"
                className={SERIES[k].stroke}
              />
            ),
        )}
        <line x1={PAD.left} x2={width - PAD.right} y1={base} y2={base} strokeWidth={1} className="stroke-rule-strong" />
        {ticks.map((t) => (
          <text key={t} x={sx(t)} y={base + 17} textAnchor="middle" className="fill-muted font-mono text-[11px]">
            {units(t)}
          </text>
        ))}
        {series.map((s, k) => {
          if (s.mean === null) return null;
          const x = sx(Math.min(domain[1], Math.max(domain[0], s.mean)));
          const labelY = PAD.top - 12 - (series.length - 1 - k) * LABEL_ROW;
          return (
            <g key={`m${k}`}>
              <line
                x1={x}
                x2={x}
                y1={base}
                y2={labelY + 4}
                strokeWidth={1.5}
                strokeDasharray="4 3"
                className={SERIES[k].stroke}
              />
              <text
                x={x}
                y={labelY}
                textAnchor={anchorAt(x)}
                strokeWidth={4}
                paintOrder="stroke"
                className={`${SERIES[k].text} stroke-card font-sans text-xs font-semibold`}
              >
                mean {units(s.mean)}
              </text>
            </g>
          );
        })}
        {hoverX !== null && (
          <line
            x1={hoverX}
            x2={hoverX}
            y1={top}
            y2={base}
            strokeWidth={1}
            className="stroke-rule-strong"
            pointerEvents="none"
          />
        )}
      </svg>
      {hover !== null && hoverX !== null && (
        <div
          className="pointer-events-none absolute top-1 z-10 border border-frame bg-card px-2 py-1 font-sans text-xs whitespace-nowrap text-ink shadow-sm"
          style={hoverX > width / 2 ? { right: width - hoverX + 8 } : { left: hoverX + 8 }}
        >
          <div className="font-mono">
            {units(hover)} {REP}
          </div>
          {series.map(
            (s, k) =>
              s.values.length > 0 && (
                <div key={s.name}>
                  <span className={`mr-1 inline-block size-2 ${SERIES[k].swatch}`} />
                  <span className="text-muted">
                    {Math.floor((100 * countBelow(s.values, hover)) / s.values.length)}% of {s.name} have less
                  </span>
                </div>
              ),
          )}
        </div>
      )}
    </div>
  );
}
