/** A tiny line of recent prices. Nothing when there are fewer than two points. */
export function Sparkline({ values, width = 80, height = 20 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return <span />;
  const lo = Math.min(...values) - 0.02;
  const hi = Math.max(...values) + 0.02;
  const n = values.length - 1;
  const pts = values
    .map((v, i) => `${((i / n) * width).toFixed(1)},${(height - 2 - ((v - lo) / (hi - lo)) * (height - 4)).toFixed(1)}`)
    .join(' ');
  return (
    <svg width={width} height={height} aria-hidden>
      <polyline fill="none" stroke="#555" strokeWidth="1.3" points={pts} />
    </svg>
  );
}
