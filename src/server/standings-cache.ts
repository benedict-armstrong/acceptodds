/**
 * The generation of the leaderboard's ranked field (`views.leaderboardStandings`),
 * which values every trader and is read on the leaderboard, the portfolio and,
 * for some viewers, every page's navbar.
 *
 * A write that can move anyone's standing — a trade, a settlement, a market's
 * creation, a new account — calls `invalidateStandings()` **after its
 * commit**, the same place the engine logs. A cached field computed under an
 * older generation is never served, and one computed while a write committed
 * carries the generation it started under, so it is thrown away on the next
 * read rather than passed off as current.
 *
 * In-process, which is correct for the single app container of §11 and wrong
 * for more than one. Writers outside the process (the seed script) are
 * covered only by the cache's short TTL.
 *
 * A counter here rather than a version read from the database: `ledger_entries.created_at`
 * is not commit order, and a row every trade updates would serialize trades
 * across markets.
 */

let generation = 0;
type Change = { marketId: string; accountId?: string };
const changes = new Map<number, Change>();

export function invalidateStandings(change?: Change): void {
  generation += 1;
  if (!change) changes.clear();
  else {
    changes.set(generation, change);
    if (changes.size > 256) changes.delete(changes.keys().next().value!);
  }
}

export function standingsGeneration(): number {
  return generation;
}

/** null means a full rebuild is required (an account change, or a gap in the bounded journal). */
export function standingsChangesSince(previous: number): Change[] | null {
  const result: Change[] = [];
  for (let next = previous + 1; next <= generation; next++) {
    const change = changes.get(next);
    if (!change) return null;
    result.push(change);
  }
  return result;
}
