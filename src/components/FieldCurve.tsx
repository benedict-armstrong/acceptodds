import { StandingChart } from '@/components/StandingChart';
import { ui } from '@/components/ui';
import { ago } from '@/lib/format';
import { microToFloat } from '@/lib/money';
import type { FieldSnapshot } from '@/server/field-snapshot';

/** Micro-units as whole units, for plotting only: the chart never feeds back into money. */
const toUnits = (micro: bigint) => microToFloat(micro) / 1_000_000;

/**
 * The field's shape: the shared snapshot of every trader's net worth at
 * liquidation value (never a mark, §1.2) as a curve (`StandingChart`), the
 * viewer on it by their exact figure from the board. The snapshot may be a
 * few minutes old and says so. Nothing for a field of one. It is Figure 1
 * on both pages that show it, the leaderboard and `/profile`; a group's or
 * an institution's board draws its own members' the same way (`of`).
 */
export function FieldCurve({
  field,
  you,
  label,
  other = null,
  of,
}: {
  field: FieldSnapshot;
  /**
   * Whose net worths these are, for the caption, when not the whole field's
   * snapshot: a group's, drawn live from the board, so the caption gives no age.
   */
  of?: string;
  you: bigint | null;
  label: string | null;
  /** The trader the board is focused on (`?around=`), when that is not the viewer. */
  other?: { handle: string; worth: bigint; label: string } | null;
}) {
  const worths = field.worthsMicro;
  if (worths.length < 2) return null;
  return (
    <section aria-label="The field" className="mt-7">
      <StandingChart
        curve={field.curve}
        domain={field.domain}
        values={worths.map(toUnits)}
        you={you === null ? null : toUnits(you)}
        label={label}
        other={other && { value: toUnits(other.worth), label: other.label }}
      />
      <p className={ui.caption}>
        <b>Figure 1.</b> Net worth of {of ?? `all ${worths.length.toLocaleString('en')} traders`}, if each sold
        everything now{of ? '.' : `, as of ${ago(field.computedAt)} ago.`}
        {you !== null && ' The shaded part is everyone below you.'}
        {other && ` The dashed line is @${other.handle}.`}
      </p>
    </section>
  );
}
