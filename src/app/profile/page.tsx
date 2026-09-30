import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { FieldCurve } from '@/components/FieldCurve';
import { FollowStar } from '@/components/FollowStar';
import { MathText } from '@/components/MathText';
import { SignOut } from '@/components/SignOut';
import { TraderHeader } from '@/components/TraderHeader';
import { TableNotes } from '@/components/TableNotes';
import { ui } from '@/components/ui';
import { WorthTable } from '@/components/WorthTable';
import { minMovePp, movePp } from '@/lib/digest';
import { pct } from '@/lib/format';
import { viewerFromHeaders } from '@/server/auth';
import * as events from '@/server/events';
import { fieldSnapshot } from '@/server/field-snapshot';
import { followedListings } from '@/server/follows';
import { valuation } from '@/server/valuation';
import { leaderboardStandings, standingOf } from '@/server/views';
import { presentAffiliation } from '@/server/api/present';
import { listAffiliations } from '@/server/affiliations';
import { Affiliations } from './Affiliations';
import { DigestToggle } from './DigestToggle';

export const dynamic = 'force-dynamic';

/** The signed-in viewer's own account. Read-only; signing out goes through Better Auth's client. */
export default async function ProfilePage() {
  const viewer = await viewerFromHeaders(await headers());
  if (!viewer) redirect('/signin?next=/profile');
  const a = viewer.account;
  const v = await valuation(a.id);
  const follows = await followedListings(a.id);
  // Placed on the field by the board's own figure, as the leaderboard places them.
  const field = await leaderboardStandings({ basis: 'net_worth' });
  const row = field.find((r) => r.accountId === a.id) ?? null;
  const ahead = row ? standingOf(field, a.id, 'net_worth')?.percentAhead ?? null : null;
  const snapshot = await fieldSnapshot();
  const affiliations = (await listAffiliations(a.id)).map(presentAffiliation);
  // Tables are numbered by hand in page order: worth, then affiliations (not for bots), then follows.
  const followsTable = 1 + (v ? 1 : 0) + (a.isBot ? 0 : 1);
  events.log('me.read', { accountId: a.id });

  return (
    <main className={`${ui.page} max-w-[560px]`}>
      <TraderHeader
        account={a}
        email={viewer.email}
        admin={viewer.isAdmin}
      />

      <FieldCurve
        field={snapshot}
        you={row?.netWorthMicro ?? null}
        label={row ? (ahead === null ? 'you' : `you · ahead of ${ahead}%`) : null}
      />

      {v && (
        <WorthTable n={1} caption="Your reputation." worth={v} />
      )}
      <div className="mt-3 flex gap-4.5 font-sans text-sm">
        <Link href="/portfolio">portfolio →</Link>
        <Link href="/leaderboard">leaderboard →</Link>
      </div>

      {!a.isBot && (
        <section id="affiliations">
          <h2 className={ui.groupHeading}>Affiliations</h2>
          <Affiliations initial={affiliations} n={v ? 2 : 1} />
        </section>
      )}

      <section>
        <h2 className={ui.groupHeading}>Following</h2>
        {follows.length === 0 && (
          <div className="py-2 text-[15px] text-muted italic">
            Star a paper to follow it: <span className="not-italic">☆</span> on its page or in the list.
          </div>
        )}
        {follows.length > 0 && (
          <>
            <table className={ui.table}>
              <caption className={ui.tableCaption}>
                <b>Table {followsTable}.</b> Papers you follow, most recently followed first.
              </caption>
              <thead>
                <tr>
                  <th className={ui.th()} />
                  <th className={ui.th()}>Paper</th>
                  <th className={ui.th(true)}>
                    Accept<sup className={ui.mark}>a</sup>
                  </th>
                  <th className={ui.th(true)}>
                    24h<sup className={ui.mark}>b</sup>
                  </th>
                </tr>
              </thead>
              <tbody>
                {follows.map((f) => {
                  const pp = f.move ? Math.round(movePp(f.move)) : 0;
                  return (
                    <tr key={f.view.listing.id} className="align-baseline">
                      <td className={`${ui.td} w-[18px]`}>
                        <FollowStar listingId={f.view.listing.id} following />
                      </td>
                      <td className={ui.td}>
                        <Link
                          href={`/papers/${encodeURIComponent(f.view.listing.slug)}`}
                          className="line-clamp-2 leading-[1.35]"
                          title={f.view.listing.title}
                        >
                          <MathText text={f.view.listing.title} />
                        </Link>
                      </td>
                      <td className={`${ui.td} ${ui.num}`}>{f.move && f.main ? pct(f.move.now) : '—'}</td>
                      <td
                        className={`${ui.td} ${ui.num} whitespace-nowrap ${
                          pp > 0 ? 'text-up' : pp < 0 ? 'text-down' : 'text-muted'
                        }`}
                      >
                        {f.move && f.main ? `${pp > 0 ? '+' : pp < 0 ? '−' : '±'}${Math.abs(pp)} pp` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <TableNotes
              notes={[
                ['a', 'The chance, on its main market, that the paper is accepted in any form.'],
                ['b', 'The change in that chance over the last 24 hours, in percentage points.'],
              ]}
            />
          </>
        )}
        {follows.length > 0 && (
          <div className="mt-2 font-sans text-sm">
            <Link href="/?following=1&kind=all&status=all">followed papers on the home page →</Link>
          </div>
        )}
      </section>

      <section id="email">
        <h2 className={ui.groupHeading}>Email</h2>
        <DigestToggle optIn={a.digestOptIn} minMovePp={minMovePp()} />
      </section>

      <hr className="my-10 border-rule-soft" />
      <div className="flex justify-end gap-2">
        <Link
          href={`/people/${encodeURIComponent(a.handle)}`}
          className={ui.btn({ ghost: true, inline: true, flush: true })}
          title="Your page as everyone else sees it"
        >
          view public page
        </Link>
        <SignOut className={ui.btn({ ghost: true, inline: true, flush: true })} />
      </div>
    </main>
  );
}

