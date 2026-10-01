/**
 * LMSR cost function. Pure maths.
 *
 * This module imports nothing, on purpose: no storage, no accounts, no money
 * types. It is the one place in the app whose correctness can be established
 * without a database, and `tests/unit/lmsr.test.ts` is its real specification.
 *
 * ## Units
 *
 * LMSR is scale-invariant: `cost(k*q, k*b) === k * cost(q, b)`, and
 * `prices(k*q, k*b) === prices(q, b)`. So these functions are unit-agnostic —
 * feed them share counts and a `b` in micro-units and the cost comes back in
 * micro-units, which is exactly what `server/engine.ts` does. Nothing here
 * knows what a micro-unit is.
 *
 * Everything here is `number`. The cost is irrational by construction
 * (§1.6: exactness inside the maths is unavailable), so the rounding to
 * integer micro-units happens exactly once, in `lib/money.ts`, at the
 * persistence boundary.
 */

/** Natural log of the number of outcomes; the venue's worst-case subsidy is `b * this`. */
function lnN(n: number): number {
  return Math.log(n);
}

function assertValid(shares: number[], b: number): void {
  if (!(b > 0) || !Number.isFinite(b)) {
    throw new RangeError(`lmsr: b must be finite and > 0, got ${b}`);
  }
  if (shares.length === 0) {
    throw new RangeError('lmsr: need at least one outcome');
  }
  for (const q of shares) {
    if (!Number.isFinite(q)) {
      throw new RangeError(`lmsr: share quantities must be finite, got ${q}`);
    }
  }
}

/**
 * `C(q) = b * ln( sum_i exp(q_i / b) )`.
 *
 * Computed shift-invariantly — the maximum of `q_i / b` is subtracted before
 * the exponential and added back afterwards. Without that this overflows to
 * `Infinity` on any market that has moved decisively, which is exactly the
 * market anyone cares about.
 */
export function cost(shares: number[], b: number): number {
  assertValid(shares, b);
  let max = -Infinity;
  for (const q of shares) {
    const x = q / b;
    if (x > max) max = x;
  }
  let sum = 0;
  for (const q of shares) {
    sum += Math.exp(q / b - max);
  }
  return b * (max + Math.log(sum));
}

/**
 * Implied probabilities: `p_i = exp(q_i/b) / sum_j exp(q_j/b)`.
 *
 * Sums to 1 and every element is strictly inside (0, 1) — a softmax cannot
 * produce a certainty, which is why the venue always has a quote.
 */
export function prices(shares: number[], b: number): number[] {
  assertValid(shares, b);
  let max = -Infinity;
  for (const q of shares) {
    const x = q / b;
    if (x > max) max = x;
  }
  const exps = shares.map((q) => Math.exp(q / b - max));
  let sum = 0;
  for (const e of exps) sum += e;
  return exps.map((e) => e / sum);
}

/**
 * What it costs to move `outcomeIndex` by `delta` shares: `C(q') - C(q)`.
 *
 * Positive `delta` is a buy and returns a positive cost. Negative `delta` is a
 * sell and returns a negative cost, i.e. proceeds. **There is no separate sell
 * path**, here or in the engine.
 *
 * Note what this function is *not*: it is not `delta * price`. The price moves
 * across the trade, so a mark computed at the current price is not a sale
 * price (invariant §1.1). This function prices the whole size, slippage
 * included, and is the only honest answer.
 */
export function costToTrade(shares: number[], outcomeIndex: number, delta: number, b: number): number {
  assertValid(shares, b);
  if (!Number.isInteger(outcomeIndex) || outcomeIndex < 0 || outcomeIndex >= shares.length) {
    throw new RangeError(`lmsr: outcomeIndex ${outcomeIndex} out of range`);
  }
  if (!Number.isFinite(delta)) {
    throw new RangeError(`lmsr: delta must be finite, got ${delta}`);
  }
  const after = shares.slice();
  after[outcomeIndex] += delta;
  return cost(after, b) - cost(shares, b);
}

/**
 * The inverse of a buy: how many shares of `outcomeIndex` a spend of `budget`
 * buys, so that `costToTrade(shares, outcomeIndex, result, b) === budget`.
 *
 * Buying `Δ` costs `b · ln(1 − p + p·e^{Δ/b})` with `p` the outcome's price
 * now, so `Δ = b · ln(1 + (e^{x} − 1)/p)` with `x = budget / b`. It is
 * evaluated as `b · (x + ln(e^{−x} + (1 − e^{−x})/p))`, which neither
 * overflows for a large spend nor loses the small one.
 *
 * Buys only: `budget` must be ≥ 0. A spend is not a sell's proceeds, and a
 * sell is sized in the shares held.
 */
export function sharesForCost(shares: number[], outcomeIndex: number, budget: number, b: number): number {
  const p = prices(shares, b)[outcomeIndex];
  if (p === undefined || !Number.isInteger(outcomeIndex)) {
    throw new RangeError(`lmsr: outcomeIndex ${outcomeIndex} out of range`);
  }
  if (!Number.isFinite(budget) || budget < 0) {
    throw new RangeError(`lmsr: budget must be finite and >= 0, got ${budget}`);
  }
  const x = budget / b;
  return b * (x + Math.log(Math.exp(-x) - Math.expm1(-x) / p));
}

/**
 * The venue's worst-case subsidy for a market with this `b` and this many
 * outcomes: `b * ln(n)`.
 *
 * This is real reputation and it comes from somewhere — the house account is
 * debited by exactly this at market creation (invariant §1.7).
 */
export function maxSubsidy(b: number, outcomes: number): number {
  if (!(b > 0) || !Number.isFinite(b)) {
    throw new RangeError(`lmsr: b must be finite and > 0, got ${b}`);
  }
  if (!Number.isInteger(outcomes) || outcomes < 1) {
    throw new RangeError(`lmsr: outcomes must be a positive integer, got ${outcomes}`);
  }
  return b * lnN(outcomes);
}

/**
 * The share vector that opens a market at the given prior: `q0_i = b·ln(p_i /
 * p_min)`. Every element is ≥ 0 (the least likely outcome starts at 0), so
 * the engine's "no short positions, every `q_i ≥ 0`" holds from the first
 * trade, and `prices(q0, b)` is exactly the prior. LMSR prices are
 * shift-invariant, so this is the same market as `b·ln(p_i)` shifted up by the
 * constant that makes it non-negative.
 *
 * What it costs the house is `cost(q0, b) = b·ln(1/p_min)`, which is
 * `b·ln(n)` for a uniform prior and more for a lopsided one: the maker has to
 * be able to pay out the least likely outcome winning. See `createMarket`.
 *
 * `prior` is normalised, so any positive weights will do.
 */
export function openingShares(prior: number[], b: number): number[] {
  if (!(b > 0) || !Number.isFinite(b)) {
    throw new RangeError(`lmsr: b must be finite and > 0, got ${b}`);
  }
  if (prior.length < 2) {
    throw new RangeError('lmsr: a prior needs at least two outcomes');
  }
  for (const p of prior) {
    if (!(p > 0) || !Number.isFinite(p)) {
      throw new RangeError(`lmsr: every prior probability must be finite and > 0, got ${p}`);
    }
  }
  const min = Math.min(...prior);
  return prior.map((p) => b * Math.log(p / min));
}

/**
 * Fraction of the field's total capital the house is willing to put at risk as
 * subsidy. `b` is then chosen so that `b * ln(n)` equals exactly this fraction
 * of `balance * traders`.
 *
 * Bigger means a deeper, harder-to-move market and a bigger house bill.
 */
export const SUBSIDY_FRACTION = 0.1;

/**
 * Size `b` from the expected field and the starting balance.
 *
 * **Call this once, at market creation, and store the result on the market
 * row** (invariant §1.3). `b` must never change once trading starts:
 * recomputing it changes the cost function under existing positions and lets a
 * trader extract reputation from the transition. A `b` that grows with volume
 * is Othman et al.'s liquidity-sensitive LMSR, a different formula with
 * different invariants, and it is out of scope here.
 *
 * The sizing: a `b` small enough for one trader to pin the price makes the
 * market that trader's opinion, so `b` scales with the total capital in the
 * room (`balance * traders`), not with a global constant. Solving
 * `b * ln(n) = SUBSIDY_FRACTION * balance * traders` gives the house a bill it
 * chose and every trader a price impact of roughly `ln(n) / (f * traders)` for
 * their whole stack — which shrinks as the field grows, as it should.
 *
 * Returns `b` in whatever unit `balance` was given in (micro-units, in this
 * app).
 */
export function liquidityFor(balance: number, traders: number, outcomes: number): number {
  if (!Number.isFinite(balance) || balance <= 0) {
    throw new RangeError(`lmsr: balance must be finite and > 0, got ${balance}`);
  }
  if (!Number.isFinite(traders) || traders < 1) {
    throw new RangeError(`lmsr: traders must be >= 1, got ${traders}`);
  }
  if (!Number.isInteger(outcomes) || outcomes < 2) {
    // One outcome is not a market: ln(1) = 0 and the price is always 1.
    throw new RangeError(`lmsr: a market needs at least 2 outcomes, got ${outcomes}`);
  }
  return (SUBSIDY_FRACTION * balance * traders) / lnN(outcomes);
}
