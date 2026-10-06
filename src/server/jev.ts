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
 * (`server/market-start.ts`). The only model call the platform makes.
 *
 * `null` whenever there is no answer — no key, a timeout, an error, a reply
 * of the wrong shape — and the caller opens at the template's fallback. A
 * first trade never waits on, or fails with, the model.
 */
export async function jevPrices(
  listing: Pick<Listing, 'id' | 'title' | 'summary' | 'keywords' | 'primaryArea'>,
  template: MarketTemplate,
  database: Database = getDb(),
): Promise<number[] | null> {
  const key = process.env.NANOGPT_API_KEY;
  if (!key) return null;
  const labels = template.outcomes;
  try {
    const [full] = await database
      .select({ body: listingTexts.body })
      .from(listingTexts)
      .where(eq(listingTexts.listingId, listing.id));
    const ask = (text: string) =>
      fetch(process.env.JEV_URL ?? 'https://nano-gpt.com/api/v1/decisions', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: process.env.JEV_MODEL ?? 'typesafe/jev-1.13',
          state: { paper: text },
          questions: {
            decision: {
              type: 'choice',
              instructions: template.jev.instructions,
              criteria: Object.fromEntries(labels.map((l, i) => [l, template.jev.criteria[i]])),
            },
          },
        }),
        signal: AbortSignal.timeout(JEV_TIMEOUT_MS),
      });
    let res = await ask(paperText(listing, full?.body ?? null));
    // A full text past JEV's context is refused outright (a 400): the abstract still gets an answer.
    if (res.status === 400 && full) res = await ask(paperText(listing, null));
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as {
      answers?: { decision?: { probabilities?: Record<string, unknown> } };
      usage?: { cost?: unknown };
    };
    await recordCost(body.usage?.cost, database);
    const p = body.answers?.decision?.probabilities;
    const raw = labels.map((l) => Number(p?.[l]));
    if (raw.some((x) => !Number.isFinite(x) || x < 0)) throw new Error(`unexpected answer ${JSON.stringify(p)}`);
    return floored(raw);
  } catch (err) {
    console.error('jev: no opening prices, using the fallback:', err);
    return null;
  }
}

const JEV_TIMEOUT_MS = 15_000;

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
