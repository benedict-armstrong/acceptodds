import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { Amount } from '@/components/Amount';
import { DetailsTable } from '@/components/DetailsTable';
import { FieldCurve } from '@/components/FieldCurve';
import { OutcomeSwatch } from '@/components/OutcomeBar';
import { PaperName } from '@/components/PaperName';
import { TableNotes } from '@/components/TableNotes';
import { TraderHeader } from '@/components/TraderHeader';
import { ui } from '@/components/ui';
import { WORTH_NOTES } from '@/components/WorthTable';
import { signedRep } from '@/lib/format';
import { publicPositionPath } from '@/lib/links';
import { ApiError } from '@/server/api/errors';
import { viewerFromHeaders } from '@/server/auth';
import * as events from '@/server/events';
import { fieldSnapshot } from '@/server/field-snapshot';
import { publicPositionsOf } from '@/server/public-positions';
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

const POSITION_STATE = { held: 'held', sold: 'sold', won: 'won', lost: 'lost', void: 'void' } as const;

/**
 * A trader's public page: what `GET /accounts/{handle}` and the leaderboard
 * already make public, and the positions they chose to make public (#36),
 * and nothing more. No other holdings, no follows, no email — comments are
 * anonymous but for the author's stake, so a list of someone's positions
 * would unmask them; a public one does, for its market, which is why it is
 * the holder's choice, one at a time. Net worth is liquidation value, never
 * a mark (§1.2). House accounts are not people and 404.
 */
export default async function PersonPage({ params }: { params: Promise<{ handle: string }> }) {
  const handle = decodeURIComponent((await params).handle);
  const { account: a, settledPnlMicro, settledMarkets } = await load(handle);
  const viewer = await viewerFromHeaders(await headers());
  const field = await leaderboardStandings({ basis: 'net_worth' });
  const row = field.find((r) => r.accountId === a.id) ?? null;
  const standing = row ? standingOf(field, a.id, 'net_worth') : null;
  const snapshot = await fieldSnapshot();
  const shared = await publicPositionsOf(a.id);
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

      {shared.length > 0 && (
        <>
          <div className={`${ui.tableScroll} mt-8`}>
            <table className={ui.table}>
              <caption className={ui.tableCaption}>
                <b>Table 2.</b> Positions @{a.handle} made public, newest first.
              </caption>
              <thead>
                <tr>
                  <th className={ui.th()}>Paper</th>
                  <th className={ui.th()}>Outcome</th>
                  <th className={ui.th()}>Status</th>
                  <th className={ui.th(true)}>
                    P&L<sup className={ui.mark}>a</sup>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shared.map((p) => (
                  <tr key={p.id}>
                    <td className={ui.td}>
                      <PaperName
                        m={{
                          marketSlug: p.market.slug,
                          listingSlug: p.market.listingSlug,
                          listingTitle: p.market.listingTitle,
                          question: p.market.question,
                        }}
                      />
                    </td>
                    <td className={`${ui.td} whitespace-nowrap`}>
                      <OutcomeSwatch ordinal={p.outcome.ordinal} outcomes={p.outcome.count} />
                      {p.outcome.label}
                    </td>
                    <td className={ui.td}>
                      <Link href={publicPositionPath(p.id)}>{POSITION_STATE[p.state]}</Link>
                    </td>
                    <td className={`${ui.td} ${ui.num} ${ui.pnl(p.pnlMicro)}`}>{signedRep(p.pnlMicro)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TableNotes
            notes={[
              [
                'a',
                <>
                  Sales, plus what selling the rest would pay now or the settlement payout, minus what the buys cost.
                  Each status opens the position.
                </>,
              ],
            ]}
          />
        </>
      )}
    </main>
  );
}
