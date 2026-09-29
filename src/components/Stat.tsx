import { ui } from './ui';

/** A labelled figure in a stat row (portfolio, profile). `tone` is a text colour, e.g. `ui.pnl(…)`. */
export function Stat({ label, value, tone = 'text-ink', title }: { label: string; value: string; tone?: string; title?: string }) {
  return (
    <div title={title}>
      <div className={ui.label}>{label}</div>
      <div className={`font-mono text-lg ${tone}`}>{value} rep</div>
    </div>
  );
}
