import { notFound } from 'next/navigation';
import { ApiError } from '@/server/api/errors';
import { leaderboardStandings, publicAccount, standingOf } from '@/server/views';

/**
 * A trader's public account and their place on the net-worth board, for the
 * page and its link preview; the 404 page for an unknown handle or a house
 * account. `row`/`standing` are null for a trader not on the board.
 */
export async function loadPerson(rawHandle: string) {
  const handle = decodeURIComponent(rawHandle);
  let account;
  try {
    account = await publicAccount(handle);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
  const field = await leaderboardStandings({ basis: 'net_worth' });
  const id = account.account.id;
  const row = field.find((r) => r.accountId === id) ?? null;
  const standing = row ? standingOf(field, id, 'net_worth') : null;
  return { ...account, field, row, standing };
}
