/**
 * Micro-unit conversion and rounding. One place, on purpose.
 *
 * Invariant §1.6: money is an integer number of micro-units, in a `BIGINT`
 * column and a `bigint` in TypeScript. Never a float, never a `numeric` read
 * into a JS number.
 *
 * The LMSR cost is irrational by construction, so exactness inside the maths
 * is unavailable. The maths happens in `number` (see `lib/lmsr.ts`) and is
 * rounded **exactly once**, here, on its way to the database. If you find
 * yourself rounding somewhere else, that is a second place money can be
 * created or destroyed.
 */

/** 1 unit of reputation = 1,000,000 micro-units. */
export const MICRO_PER_UNIT = 1_000_000n;

/** Same constant, as a `number`, for the float side of the boundary. */
export const MICRO_PER_UNIT_NUMBER = 1_000_000;

function assertFinite(x: number, what: string): void {
  if (!Number.isFinite(x)) {
    throw new RangeError(`money: ${what} must be finite, got ${x}`);
  }
  if (Math.abs(x) > Number.MAX_SAFE_INTEGER) {
    // Past 2^53 a double no longer represents every integer, so the bigint we
    // would produce is a guess. Refuse rather than quietly lose units.
    throw new RangeError(`money: ${what} exceeds safe integer range: ${x}`);
  }
}

/**
 * Round a cost that the maths produced in (fractional) micro-units to an
 * integer number of micro-units, **always in the house's favour**.
 *
 * `Math.ceil` does this for both directions at once, which is why it is used
 * rather than a nearest-rounding rule:
 *
 * - a buy costs a positive amount, and ceiling charges the trader the extra
 *   fraction of a micro-unit;
 * - a sell produces a negative cost (proceeds), and ceiling pays the trader
 *   the smaller amount.
 *
 * The consequence is worth stating: the sub-micro-unit remainder always
 * accrues to the venue, so an integer round trip can never profit, and the
 * subsidy bound `b * ln(n)` holds in integers and not merely in the reals.
 */
export function costToMicro(costInMicro: number): bigint {
  assertFinite(costInMicro, 'cost');
  return BigInt(Math.ceil(costInMicro));
}

/**
 * Round a share quantity that the maths produced in (fractional) micro-shares
 * to an integer. Shares are not money, so this is nearest-rounding, half away
 * from zero.
 */
export function sharesToMicro(sharesInMicro: number): bigint {
  assertFinite(sharesInMicro, 'shares');
  const rounded =
    sharesInMicro < 0 ? -Math.round(-sharesInMicro) : Math.round(sharesInMicro);
  return BigInt(rounded);
}

/** Whole units -> micro-units. `1.5` -> `1500000n`. */
export function unitsToMicro(units: number): bigint {
  assertFinite(units * MICRO_PER_UNIT_NUMBER, 'units');
  const scaled = units * MICRO_PER_UNIT_NUMBER;
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  return BigInt(rounded);
}

/**
 * Micro-units -> a `number` of whole units.
 *
 * **Display and arithmetic-free contexts only.** The result is a float; never
 * feed it back into a balance, a ledger entry or a comparison that decides
 * whether a trade is affordable.
 */
export function microToUnits(micro: bigint): number {
  return Number(micro) / MICRO_PER_UNIT_NUMBER;
}

/**
 * Micro-units -> a `number`, for handing to `lib/lmsr.ts`.
 *
 * Exact for every balance and share count this venue will ever hold
 * (|micro| < 2^53 is about 9 billion units), and it throws rather than lie if
 * that ever stops being true.
 */
export function microToFloat(micro: bigint): number {
  if (micro > BigInt(Number.MAX_SAFE_INTEGER) || micro < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`money: ${micro} micro-units exceeds safe integer range`);
  }
  return Number(micro);
}

/** Fixed-point decimal string, for humans and for logs. `1500000n` -> `"1.50"`. */
export function formatMicro(micro: bigint, decimals = 2): string {
  if (decimals < 0 || decimals > 6) {
    throw new RangeError(`money: decimals must be 0..6, got ${decimals}`);
  }
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  const whole = abs / MICRO_PER_UNIT;
  const frac = abs % MICRO_PER_UNIT;
  const sign = negative ? '-' : '';
  if (decimals === 0) return `${sign}${whole}`;
  const fracStr = frac.toString().padStart(6, '0').slice(0, decimals);
  return `${sign}${whole}.${fracStr}`;
}

/**
 * A decimal string a person typed ("12", "0.5", "1,000.25") -> micro-units,
 * exactly, with no float in between. `null` for anything that is not a
 * non-negative decimal with at most 6 places.
 */
export function parseUnits(input: string): bigint | null {
  const s = input.trim().replace(/[,_\s]/g, '');
  const m = /^(\d*)(?:\.(\d{0,6}))?$/.exec(s);
  if (!m || (m[1] === '' && (m[2] ?? '') === '')) return null;
  const whole = BigInt(m[1] || '0');
  const frac = BigInt((m[2] ?? '').padEnd(6, '0') || '0');
  return whole * MICRO_PER_UNIT + frac;
}
