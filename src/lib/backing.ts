/**
 * Pure helpers for comment backings (see `commentBackings` in `db/schema.ts`).
 * No I/O here, so the rules can be property-tested on their own.
 */

export interface BackingSlice {
  id: string;
  sharesMicro: bigint;
}

export interface TrimPlan {
  /** Backings to remove entirely. */
  remove: string[];
  /** At most one backing to shrink, to the new (positive) size. */
  reduce: { id: string; sharesMicro: bigint } | null;
}

/**
 * What to take away from an account's backings on one outcome so that their
 * total fits in `positionMicro` again. **LIFO**: `newestFirst` must be ordered
 * newest first, and the plan eats from the front — whole backings while the
 * excess covers them, then shrinks the next one by what is left.
 *
 * Minimal: after the plan the total is exactly `min(Σ, max(position, 0))`, so
 * nothing is removed that did not have to be. A total already within the
 * position gives an empty plan.
 */
export function lifoTrim(newestFirst: readonly BackingSlice[], positionMicro: bigint): TrimPlan {
  const total = newestFirst.reduce((s, b) => s + b.sharesMicro, 0n);
  let excess = total - (positionMicro > 0n ? positionMicro : 0n);
  const plan: TrimPlan = { remove: [], reduce: null };
  for (const b of newestFirst) {
    if (excess <= 0n) break;
    if (b.sharesMicro <= excess) {
      plan.remove.push(b.id);
      excess -= b.sharesMicro;
    } else {
      plan.reduce = { id: b.id, sharesMicro: b.sharesMicro - excess };
      excess = 0n;
    }
  }
  return plan;
}
