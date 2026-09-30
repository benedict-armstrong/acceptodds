import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { Amount } from '@/components/Amount';
import { DetailsTable } from '@/components/DetailsTable';
import { FieldCurve } from '@/components/FieldCurve';
import { TraderHeader } from '@/components/TraderHeader';
import { ui } from '@/components/ui';
import { WORTH_NOTES } from '@/components/WorthTable';
import { ApiError } from '@/server/api/errors';
import { viewerFromHeaders } from '@/server/auth';
import * as events from '@/server/events';
import { fieldSnapshot } from '@/server/field-snapshot';
import { siteName } from '@/server/share';
import { leaderboardStandings, publicAccount, standingOf } from '@/server/views';

export const dynamic = 'force-dynamic';

async function load(handle: string) {
  try {
    return await publicAccount(handle);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }
}

export async function generateMetadata({ params }: { params: Promise<{ handle: string }> }): Promise<Metadata> {
  const handle = decodeURIComponent((await params).handle);
  const { account } = await load(handle);
  return { title: `${account.displayName} (@${account.handle}) · ${siteName()}` };
}

/**
 * A trader's public page: what `GET /accounts/{handle}` and the leaderboard
 * already make public, and nothing more. No holdings, follows or email —
 * comments are anonymous but for the author's stake, so a public list of
 * someone's positions would unmask them. Net worth is liquidation value,
 * never a mark (§1.2). House accounts are not people and 404.
 */
export default async function PersonPage({ params }: { params: Promise<{ handle: string }> }) {
  const handle = decodeURIComponent((await params).handle);
  const { account: a, settledPnlMicro, settledMarkets } = await load(handle);
  const viewer = await viewerFromHeaders(await headers());
  const field = await leaderboardStandings({ basis: 'net_worth' });
  const row = field.find((r) => r.accountId === a.id) ?? null;
  const standing = row ? standingOf(field, a.id, 'net_worth') : null;
  const snapshot = await fieldSnapshot();
  events.log('account.read', { accountId: viewer?.account.id ?? null });

  const isViewer = viewer?.account.id === a.id;
  const board = `/leaderboard?around=${encodeURIComponent(a.handle)}#focus`;
  const ahead = (id: string) => standingOf(field, id, 'net_worth')?.percentAhead ?? null;
  const labelled = (who: string, id: string) => (ahead(id) === null ? who : `${who} · ahead of ${ahead(id)}%`);
  // As the leaderboard's `?around=`: this trader dashed, the viewer (if another trader) shaded.
  const mine = viewer && !isViewer ? (field.find((r) => r.accountId === viewer.account.id) ?? null) : null;

  return (
    <main className={`${ui.page} max-w-[560px]`}>
      <TraderHeader account={a}>
        {isViewer && (
          <div className="mt-1 font-sans text-[13px] text-muted">
            This is your public page, as everyone sees it. <Link href="/profile">your profile →</Link>
          </div>
        )}
      </TraderHeader>

      {isViewer ? (
        <FieldCurve field={snapshot} you={row?.netWorthMicro ?? null} label={row ? labelled('you', a.id) : null} />
      ) : (
        <FieldCurve
          field={snapshot}
          you={mine?.netWorthMicro ?? null}
          label={mine ? labelled('you', mine.accountId) : null}
          other={row && { handle: a.handle, worth: row.netWorthMicro, label: labelled(`@${a.handle}`, a.id) }}
        />
      )}

      <DetailsTable
        n={1}
        caption={<>Standing of @{a.handle}.</>}
        rows={[
          [
            'Rank by net worth',
            row && standing ? (
              <>
                #{row.rank} of {standing.fieldSize.toLocaleString('en')}
                {standing.percentAhead !== null && <> · ahead of {standing.percentAhead}%</>}
              </>
            ) : (
              '—'
            ),
          ],
          ['Net worth', row ? <Amount key="nw" micro={row.netWorthMicro} /> : '—', 'a'],
          ['Unrealized P&L', row ? <Amount key="u" micro={row.unrealizedPnlMicro} signed /> : '—', 'b'],
          ['Settled P&L', <Amount key="s" micro={settledPnlMicro} signed />, 'c'],
          ['Settled markets', settledMarkets.toLocaleString('en')],
        ]}
        notes={[
          ['a', WORTH_NOTES.netWorth],
          ['b', WORTH_NOTES.unrealized],
          ['c', WORTH_NOTES.realized],
        ]}
      />
      <div className="mt-3 font-sans text-sm">
        <Link href={board}>on the leaderboard →</Link>
      </div>
    </main>
  );
}
