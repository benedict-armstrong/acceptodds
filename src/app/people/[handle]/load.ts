import { notFound } from 'next/navigation';
import { ApiError } from '@/server/api/errors';
import { currentVenue } from '@/server/current-venue';
import { leaderboardStandings, publicAccount, standingOf } from '@/server/views';

/**
 * A trader's public account and their place on a venue's net-worth board
 * (this browser's venue), for the page and its link preview; the 404 page
 * for an unknown handle or a house account. `row`/`standing` are null for a
 * trader not on that board (who has not traded in the venue).
 */
export async function loadPerson(rawHandle: string) {
  const handle = decodeURIComponent(rawHandle);
  const kind = await currentVenue();
  let account;
  try {
    account = await publicAccount(handle);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
  const field = await leaderboardStandings({ kind, basis: 'net_worth' });
  const id = account.account.id;
  const row = field.find((r) => r.accountId === id) ?? null;
  const standing = row ? standingOf(field, id, 'net_worth') : null;
  const record = account.settledRecords.find((r) => r.kind === kind);
  return {
    account: account.account,
    kind,
    settledPnlMicro: record?.settledPnlMicro ?? 0n,
    settledMarkets: record?.settledMarkets ?? 0,
    field,
    row,
    standing,
  };
}
