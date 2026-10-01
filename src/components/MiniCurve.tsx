/**
 * A tiny bell curve with a line where the viewer sits: the navbar's view of
 * `StandingChart` (#17). `curve` is the field's density sampled evenly and
 * scaled to peak at 1, `at` the viewer's position across it, 0 to 1. The
 * part below the viewer is shaded, as on the portfolio chart. Decorative:
 * the caller carries the percentile in text (title, aria-label).
 */
export function MiniCurve({
  curve,
  at,
  width = 56,
  height = 16,
}: {
  curve: number[];
  at: number;
  width?: number;
  height?: number;
}) {
  if (curve.length < 2) return null;
  const n = curve.length - 1;
  const x = (i: number) => (i / n) * width;
  const y = (v: number) => height - 1 - v * (height - 3);
  const line = curve.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const area = `${line}L${width},${height}L0,${height}Z`;
  const youX = Math.min(width - 1, Math.max(1, at * width));
  return (
    <svg width={width} height={height} aria-hidden className="inline-block align-[-3px]">
      <clipPath id="mini-curve-below">
        <rect x={0} y={0} width={youX} height={height} />
      </clipPath>
      <path d={area} clipPath="url(#mini-curve-below)" className="fill-accent opacity-20" />
      <path d={line} fill="none" strokeWidth={1.3} strokeLinejoin="round" className="stroke-subtle" />
      <line x1={youX} x2={youX} y1={0} y2={height} strokeWidth={2} className="stroke-accent" />
    </svg>
  );
}
