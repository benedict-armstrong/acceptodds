/**
 * What a holding cost, by the average-cost method, replayed from its fills.
 *
 * A buy adds its cost to the basis. A sell removes the sold fraction of the
 * basis, so the shares still held keep their average price: selling part of
 * a position neither raises nor lowers what the rest is said to have cost.
 * A position sold to zero has no basis, and a later buy starts afresh.
 *
 * Integers throughout (§1.6); a sell's share of the basis rounds down, so the
 * shares kept carry the remainder. It is a display figure — how the viewer
 * entered, not a value and not a sale price — and nothing is paid on it.
 */
export interface Fill {
  /** Signed: negative is a sell. */
  sharesMicro: bigint;
  /** Signed: a buy's cost is positive, a sell's proceeds negative. */
  costMicro: bigint;
}

export function costBasis(fills: readonly Fill[]): { sharesMicro: bigint; basisMicro: bigint } {
  let shares = 0n;
  let basis = 0n;
  for (const f of fills) {
    if (f.sharesMicro > 0n) {
      shares += f.sharesMicro;
      basis += f.costMicro;
    } else if (f.sharesMicro < 0n && shares > 0n) {
      const sold = -f.sharesMicro > shares ? shares : -f.sharesMicro;
      basis -= (basis * sold) / shares;
      shares -= sold;
    }
  }
  return { sharesMicro: shares, basisMicro: shares === 0n ? 0n : basis };
}
