/**
 * A comment author's stake, coarsened for display: rounded **down** to
 * `STAKE_DIGITS` significant figures of micro-shares (254.312877 → 250,
 * 8.734 → 8.7, 0.0438 → 0.043). Never zero for a positive holding, never more
 * than is held.
 *
 * Why: the tape publishes every fill's exact size and the leaderboard every
 * trader's exact net worth, live. An exact stake on a comment can be matched
 * against both, which ties a comment's alias to a handle. Two figures say
 * how much someone holds, which is what a reader weighs a comment by, and
 * leave too little to match on.
 */
export const STAKE_DIGITS = 2;

export function coarseStakeMicro(sharesMicro: bigint): bigint {
  if (sharesMicro <= 0n) return 0n;
  const digits = sharesMicro.toString().length;
  if (digits <= STAKE_DIGITS) return sharesMicro;
  const unit = 10n ** BigInt(digits - STAKE_DIGITS);
  return (sharesMicro / unit) * unit;
}
