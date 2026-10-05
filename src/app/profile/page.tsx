import Link from 'next/link';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { EditName } from '@/components/EditName';
import { FollowStar } from '@/components/FollowStar';
import { MathText } from '@/components/MathText';
import { ShareProfile } from '@/components/ShareProfile';
import { SignOut } from '@/components/SignOut';
import { TraderHeader } from '@/components/TraderHeader';
import { ui } from '@/components/ui';
import { minMovePp, movePp } from '@/lib/digest';
import { pct } from '@/lib/format';
import { viewerFromHeaders } from '@/server/auth';
import * as events from '@/server/events';
import { followedListings } from '@/server/follows';
import { leaderboardStandings, standingOf } from '@/server/views';
import { presentAffiliation, presentToken } from '@/server/api/present';
import { listAffiliations } from '@/server/affiliations';
import { listTokens } from '@/server/tokens';
import { ApiKeys } from './ApiKeys';
import { Affiliations } from './Affiliations';
import { MailToggle } from './MailToggle';

export const dynamic = 'force-dynamic';

/** The signed-in viewer's own account. Read-only; signing out goes through Better Auth's client. */
export default async function ProfilePage() {
  const viewer = await viewerFromHeaders(await headers());
  if (!viewer) redirect('/signin?next=/profile');
  const a = viewer.account;
  const follows = await followedListings(a.id);
  const field = await leaderboardStandings({ basis: 'net_worth' });
  const standing = field.some((r) => r.accountId === a.id) ? standingOf(field, a.id, 'net_worth') : null;
  const affiliations = (await listAffiliations(a.id)).map(presentAffiliation);
  const apiKeys = a.userId ? (await listTokens(a.userId)).map(presentToken) : [];
  // Tables are numbered by hand in page order: affiliations (not for bots), follows (when any), then API keys.
  const followsTable = 1 + (a.isBot ? 0 : 1);
  const keysTable = followsTable + (follows.length > 0 ? 1 : 0);
  events.log('me.read', { accountId: a.id });

  return (
    <main className={`${ui.page} max-w-[560px]`}>
      <TraderHeader account={a} email={viewer.email} admin={viewer.isAdmin} />

      <div className="mt-3 flex items-center justify-center gap-4.5 font-sans text-sm">
        <ShareProfile account={a} standing={standing} />
        <EditName displayName={a.displayName} handle={a.handle} />
      </div>

      {!a.isBot && (
        <section id="affiliations">
          <h2 className={ui.groupHeading}>Affiliations</h2>
          <p className="mt-1 mb-2 text-[15px] text-subtle">
            The institutional email addresses that verify you. A confirmed address lets you trade, and its institution
            appears next to your name.
          </p>
          <Affiliations initial={affiliations} n={1} />
        </section>
      )}

      <section>
        <h2 className={ui.groupHeading}>Following</h2>
        <p className="mt-1 mb-2 text-[15px] text-subtle">
          Papers you have starred, so you can keep an eye on how their odds move.
        </p>
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
                  <th className={ui.th(true)}>Accept</th>
                  <th className={ui.th(true)}>±24h</th>
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
          </>
        )}
        {follows.length > 0 && (
          <div className="mt-2 font-sans text-sm">
            <Link href="/?following=1&kind=all&status=all">followed papers on the home page →</Link>
          </div>
        )}
      </section>

      <section id="api-keys">
        <h2 className={ui.groupHeading}>API keys</h2>
        <p className="mt-1 mb-2 text-[15px] text-subtle">
          For a script or a bot that trades as you. Send the key as{' '}
          <code className={ui.mono}>Authorization: Bearer</code>; the endpoints are in the{' '}
          <a className="underline" href="/docs">
            API reference
          </a>
          .
        </p>
        <ApiKeys initial={apiKeys} n={keysTable} canTrade={a.isBot || a.verifiedAt !== null} />
      </section>

      <section id="email">
        <h2 className={ui.groupHeading}>Email</h2>
        <p className="mt-1 mb-2 text-[15px] text-subtle">
          What we may email you, besides sign-in and confirmation mails.
        </p>
        <MailToggle
          field="digestOptIn"
          optIn={a.digestOptIn}
          name="Morning emails"
          hint="One email a day at most, only when something moved."
        >
          Email me each morning when a paper I follow has moved by {minMovePp()} percentage points or more over the last
          day.
        </MailToggle>
        <div className="mt-3">
          <MailToggle
            field="mentionMailOptIn"
            optIn={a.mentionMailOptIn}
            name="Mention emails"
            hint="At most ten a day. The email names the commenter by user id only, as the page does."
          >
            Email me when a comment mentions my user id (@id) on a paper.
          </MailToggle>
        </div>
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
