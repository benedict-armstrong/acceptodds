import { eq } from 'drizzle-orm';
import type { Listing } from '@/db/schema';
import { listingTexts, usdCosts } from '@/db/schema';
import { getDb, type Database } from '@/db';
import type { MarketTemplate } from './market-templates';

/**
 * The opening prices of a listing's market, from TypeSafe's JEV model
 * (`/v1/decisions`, the same model `../scraping` ranks related papers with),
 * over the paper's full text when `../research` supplied it,
 * asked once, when the listing's market is opened
 * (`server/market-start.ts`), and read only as a rank ({@link ranked}).
 * The only model call the platform makes.
 *
 * `null` whenever there is no answer — no key, a timeout, an error, a reply
 * of the wrong shape — and the caller opens at the template's fallback. A
 * first trade never waits on, or fails with, the model.
 */
export async function jevPrices(
  listing: Pick<Listing, 'id' | 'title' | 'summary' | 'keywords' | 'primaryArea'>,
  template: MarketTemplate & { jev: NonNullable<MarketTemplate['jev']> },
  database: Database = getDb(),
): Promise<number[] | null> {
  const key = process.env.NANOGPT_API_KEY;
  if (!key) return null;
  try {
    const [full] = await database
      .select({ body: listingTexts.body })
      .from(listingTexts)
      .where(eq(listingTexts.listingId, listing.id));
    const answer = await askJev(listing, full?.body ?? null, template, key);
    await recordCost(answer.cost, database);
    return ranked(
      answer.raw,
      template.jev.reference[answer.read],
      template.fallbackPrices,
      template.jev.spread,
      jevTargetMean(),
    );
  } catch (err) {
    console.error('jev: no opening prices, using the fallback:', err);
    return null;
  }
}

/** What JEV read: the full text, or the abstract when there is none or the full text was refused. */
export type JevRead = 'fullText' | 'abstract';

/**
 * One question to JEV about a listing, as {@link jevPrices} asks it (also `scripts/measure-jev-reference.ts`,
 * which must ask exactly the same way): its raw answer, one number per outcome, what it read, and what it
 * cost. Throws on anything but a well-formed answer.
 */
export async function askJev(
  listing: Pick<Listing, 'title' | 'summary' | 'keywords' | 'primaryArea'>,
  fullText: string | null,
  template: Pick<MarketTemplate, 'outcomes'> & {
    jev: Pick<NonNullable<MarketTemplate['jev']>, 'instructions' | 'criteria'>;
  },
  key: string,
  timeoutMs = JEV_TIMEOUT_MS,
): Promise<{ raw: number[]; read: JevRead; cost: unknown }> {
  const labels = template.outcomes;
  const ask = (text: string) =>
    fetch(process.env.JEV_URL ?? 'https://nano-gpt.com/api/v1/decisions', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: process.env.JEV_MODEL ?? JEV_MODEL,
        state: { paper: text },
        questions: {
          decision: {
            type: 'choice',
            instructions: template.jev.instructions,
            criteria: Object.fromEntries(labels.map((l, i) => [l, template.jev.criteria[i]])),
          },
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  let read: JevRead = fullText ? 'fullText' : 'abstract';
  let res = await ask(paperText(listing, fullText));
  // A full text past JEV's context is refused outright (a 400): the abstract still gets an answer.
  if (res.status === 400 && fullText) {
    read = 'abstract';
    res = await ask(paperText(listing, null));
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as {
    answers?: { decision?: { probabilities?: Record<string, unknown> } };
    usage?: { cost?: unknown };
  };
  const p = body.answers?.decision?.probabilities;
  const raw = labels.map((l) => Number(p?.[l]));
  if (raw.some((x) => !Number.isFinite(x) || x < 0) || !(raw.reduce((a, x) => a + x, 0) > 0)) {
    throw new Error(`unexpected answer ${JSON.stringify(p)}`);
  }
  return { raw, read, cost: body.usage?.cost };
}

/** The model the venues' reference samples were measured with. `JEV_MODEL` overrides it, and then they need re-measuring. */
export const JEV_MODEL = 'typesafe/jev-1.13';

const JEV_TIMEOUT_MS = 15_000;

/**
 * An answer's score: the log-odds of its headline, `1 − P(last)` (`lib/headline.ts`), clamped so a
 * certain answer is still a number. Only its rank among the reference sample's scores is ever used.
 */
export function jevScore(raw: number[]): number {
  const total = raw.reduce((a, x) => a + x, 0);
  const last = Math.min(Math.max(raw[raw.length - 1] / total, 1e-6), 1 - 1e-6);
  return Math.log((1 - last) / last);
}

/**
 * JEV's answer, kept only as a rank. JEV orders papers usefully, but its level is not a probability: told the
 * base rate, its median answer is still about 80% Accept, and a fixed correction for that drifts with the
 * model and with what it reads. So an answer is placed among JEV's own
 * answers to a random sample of the venue's listings, read the same way (`reference`, sorted scores), and
 * that percentile `u` becomes a headline drawn from a target distribution we choose: logit-normal, its median
 * at the prior's headline unless a target mean is supplied, and its spread `spread` in log-odds.
 * With a target mean, solve for the center of the logit-normal before applying the percentile.
 * Finite reference samples, ties, the price floor and which papers people open can shift the realized mean.
 * A shift in JEV's level moves no opening price; how far JEV may move one is `spread`'s call alone.
 *
 * Ties (JEV's answers are coarse) take the middle of their run, and `u` stays inside `(0, 1)`, so the
 * extremes are bounded by the sample size. The other outcomes share the headline in proportion to JEV's
 * answer (to the prior's, if JEV gave them nothing); the last gets the rest. `null` without a reference.
 */
export function ranked(
  raw: number[],
  reference: readonly number[],
  prior: number[],
  spread: number,
  targetMean?: number,
): number[] | null {
  if (reference.length === 0) return null;
  const s = jevScore(raw);
  let below = 0;
  let equal = 0;
  for (const r of reference) {
    if (r < s) below++;
    else if (r === s) equal++;
  }
  const u = (below + equal / 2 + 0.5) / (reference.length + 1);
  const n = prior.length;
  const h0 = 1 - prior[n - 1];
  const center = targetMean === undefined ? Math.log(h0 / (1 - h0)) : meanCenter(targetMean, spread);
  const h = 1 / (1 + Math.exp(-(center + spread * normalQuantile(u))));
  const head = raw.slice(0, n - 1);
  const shares = head.some((x) => x > 0) ? head : prior.slice(0, n - 1);
  const total = shares.reduce((a, x) => a + x, 0);
  const prices = [...shares.map((x) => (h * x) / total), 1 - h];
  return prices.every((x) => x >= PRICE_FLOOR) ? prices : floored(prices);
}

/**
 * Desired mean headline for JEV seeds, independently of the venue's fallback/base rate.
 * Decimal probability (0.28 = 28%). Reject invalid settings through jevPrices' fallback path.
 */
export function jevTargetMean(): number {
  const value = process.env.JEV_TARGET_MEAN;
  const mean = value === undefined ? 0.28 : Number(value);
  if (!Number.isFinite(mean) || mean < PRICE_FLOOR || mean > 1 - PRICE_FLOOR) {
    throw new Error('JEV_TARGET_MEAN must be a decimal probability between 0.05 and 0.95');
  }
  return mean;
}

/** Midpoint quadrature over normal quantiles; bisection preserves the configured log-odds spread. */
function meanCenter(mean: number, spread: number): number {
  const scores = Array.from({ length: 2048 }, (_, i) => spread * normalQuantile((i + 0.5) / 2048));
  let low = -40 - 8 * Math.abs(spread);
  let high = -low;
  for (let i = 0; i < 48; i++) {
    const center = (low + high) / 2;
    const average = scores.reduce((sum, score) => sum + 1 / (1 + Math.exp(-(center + score))), 0) / scores.length;
    if (average < mean) low = center;
    else high = center;
  }
  return (low + high) / 2;
}

/** Φ⁻¹, the standard normal quantile (Acklam's rational approximation, relative error below 1.2e-9). */
export function normalQuantile(p: number): number {
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239,
  ];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968,
    2.938163982698783,
  ];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p > 1 - lo) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

/**
 * The least an outcome may open at. The house pays `b·ln(1/p_min)` for a
 * market opened at a prior (§1.7), so an unbounded answer would make one
 * market cost the house anything; this caps it at `b·ln(1/PRICE_FLOOR)`.
 */
export const PRICE_FLOOR = 0.05;

/** Normalized, then mixed with the floor: `(1 − n·f)·p + f`, so every price is ≥ f and they still sum to 1. */
export function floored(raw: number[]): number[] | null {
  const total = raw.reduce((a, x) => a + x, 0);
  if (!(total > 0)) return null;
  const f = PRICE_FLOOR;
  return raw.map((x) => (1 - raw.length * f) * (x / total) + f);
}

/**
 * The listing as JEV reads it: what `../research` supplied, nothing fetched.
 * Its full text when it has one (`listing_texts`), cut at
 * {@link FULL_TEXT_CHARS}; else the abstract.
 */
export function paperText(
  l: Pick<Listing, 'title' | 'summary' | 'keywords' | 'primaryArea'>,
  fullText: string | null,
): string {
  return [
    `Title: ${l.title}`,
    l.primaryArea ? `Area: ${l.primaryArea}` : null,
    l.keywords.length > 0 ? `Keywords: ${l.keywords.join(', ')}` : null,
    fullText ? `Paper:\n${fullText.slice(0, FULL_TEXT_CHARS)}` : l.summary ? `Abstract: ${l.summary}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * The most of a full text JEV is sent. Measured 2026-10-06: 120k characters (about 24k tokens) is
 * answered, 200k refused. `JEV_MAX_CHARS` overrides.
 */
const FULL_TEXT_CHARS = Number(process.env.JEV_MAX_CHARS) || 120_000;

/** Real USD, in its own ledger (§1.5), never reputation. A failure to record never fails the trade. */
async function recordCost(cost: unknown, database: Database) {
  const usd = Number(cost);
  if (!Number.isFinite(usd) || usd <= 0) return;
  try {
    await database.insert(usdCosts).values({ source: 'jev', amountUsdMicro: BigInt(Math.ceil(usd * 1e6)) });
  } catch (err) {
    console.error('jev: could not record cost:', err);
  }
}
