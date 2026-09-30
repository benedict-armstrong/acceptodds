import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { Amount } from '@/components/Amount';
import { DetailsTable } from '@/components/DetailsTable';
import { FieldCurve } from '@/components/FieldCurve';
import { FollowStar } from '@/components/FollowStar';
import { MathText } from '@/components/MathText';
import { SignOut } from '@/components/SignOut';
import { TraderHeader } from '@/components/TraderHeader';
import { ui } from '@/components/ui';
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
        <DetailsTable
          n={1}
          caption="Your reputation. Net worth is cash plus what selling every holding now would pay."
          rows={[
            ['Cash', <Amount key="cash" micro={v.cashMicro} />],
            ['Net worth', <Amount key="nw" micro={v.netWorthMicro} />],
            ['Unrealized P&L', <Amount key="u" micro={v.unrealizedPnlMicro} signed />],
            ['Realized P&L', <Amount key="r" micro={v.realizedPnlMicro} signed />],
          ]}
        />
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
        {follows.map((f) => {
          const pp = f.move ? Math.round(movePp(f.move)) : 0;
          return (
            <div
              key={f.view.listing.id}
              className="grid grid-cols-[18px_1fr_auto] items-baseline gap-x-2.5 border-b border-dotted border-rule-strong py-1.5"
            >
              <FollowStar listingId={f.view.listing.id} following />
              <Link
                href={`/papers/${encodeURIComponent(f.view.listing.slug)}`}
                className="line-clamp-2 leading-[1.35]"
                title={f.view.listing.title}
              >
                <MathText text={f.view.listing.title} />
              </Link>
              <span className="text-right font-mono text-[13px] whitespace-nowrap" title="price now; change over 24 hours">
                {f.move && f.main ? (
                  <>
                    <span className="font-serif text-sm">accept </span>
                    {pct(f.move.now)}{' '}
                    <span className={pp > 0 ? 'text-up' : pp < 0 ? 'text-down' : 'text-muted'}>
                      {pp > 0 ? '+' : pp < 0 ? '−' : '±'}
                      {Math.abs(pp)} pp
                    </span>
                  </>
                ) : (
                  <span className="text-muted">—</span>
                )}
              </span>
            </div>
          );
        })}
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

      <hr className="my-6 border-rule-soft" />
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

