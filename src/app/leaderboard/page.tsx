import { ReadingListTable } from '@/components/ReadingList';
import { readingList } from '@/server/reading';
import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { Authors } from '@/components/Authors';
import { BoardPicker } from '@/components/BoardPicker';
import { GroupActions, NewGroupButton } from '@/components/Groups';
import { Pager } from '@/components/Pager';
import { Pnl, PnlToggleHeading, PnlToggleProvider } from '@/components/PnlToggle';
import { FieldCurve } from '@/components/FieldCurve';
import { TableNotes } from '@/components/TableNotes';
import { TitleBlock } from '@/components/TitleBlock';
import { ui } from '@/components/ui';
import { REP, rep } from '@/lib/format';
import { standingBand } from '@/lib/leaderboard';
import { groupPath, institutionPath } from '@/lib/links';
import { authHref } from '@/lib/return-to';
import { normalizeSearch, SEARCH_MAX_LENGTH } from '@/lib/search';
import { institutionsMatch, parseTraderSearch } from '@/lib/trader-query';
import { viewerFromHeaders } from '@/server/auth';
import * as events from '@/server/events';
import { fieldSnapshot, shapeOf } from '@/server/field-snapshot';
import { groupById, groupMembersOf, groupsOf, roleIn } from '@/server/groups';
import {
  leaderboardStandings,
  matchingTraders,
  standingOf,
  traderInstitutions,
  type LeaderboardBasis,
  type LeaderboardRow,
} from '@/server/views';

export const dynamic = 'force-dynamic';

/** Traders per page, on the board or a search. */
const PAGE = 50;

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Two rankings. "Net worth" is **liquidation value** — cash plus what selling
 * every open holding now would pay — which a trader cannot inflate with their
 * own price impact. The mark-based net worth of §1.2 is never shown here.
 * "Settled profit" counts settled markets only. The UI opens on net worth;
 * the API's default basis stays `settled_pnl`.
 *
 * Shows the board a page at a time (`?page=`), from the top;
 * `?around=<handle>` (where a people search leads, and "show me") opens on
 * that trader's page, highlighted. `?institution=` ranks one institution among itself,
 * `?group=` one group (#25); either opens like a paper, its members as the
 * author line, with its own Figure 1. `?q=` finds traders by name and
 * `institution:` and `is:bot` (`lib/trader-query.ts`; `is:bot` keeps the
 * viewer's row too), each at their rank on the board.
 * The title names the board — "Global leaderboard" — and its name is a
 * find box over the boards (`BoardPicker`): global, the viewer's
 * institutions and groups, and any institution by name. "+ New group" sits
 * under the search.
 *
 * Signed out, there is no net worth column, and P/L is a blurred
 * placeholder: the figures never reach the page. The API still serves them; this is only
 * what the page shows.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const basis: LeaderboardBasis = one(sp.basis) === 'settled_pnl' ? 'settled_pnl' : 'net_worth';
  const institution = one(sp.institution)?.trim() || null;
  const groupId = one(sp.group)?.trim() || null;
  const q = normalizeSearch(one(sp.q));
  const around = one(sp.around)?.trim() || null;
  const requested = Math.max(0, Number.parseInt(one(sp.page) ?? '0', 10) || 0);

  const viewer = await viewerFromHeaders(await headers());
  const group = groupId === null ? null : UUID.test(groupId) ? await groupById(groupId) : null;
  if (groupId !== null && group === null) notFound();
  const [field, members, role, myGroups, allInstitutions] = await Promise.all([
    leaderboardStandings({ basis, institution, group: group?.id }),
    group ? groupMembersOf(group.id) : null,
    group ? roleIn(group, viewer?.account.id ?? null) : null,
    viewer ? groupsOf(viewer.account.id) : [],
    traderInstitutions(),
  ]);
  const groupReading = group ? await readingList(group.id, viewer?.account.id ?? null) : null;
  const board = group !== null || institution !== null;
  // A group's or an institution's members by net worth: its author line, and its figure.
  const byWorth = board ? await leaderboardStandings({ basis: 'net_worth', institution, group: group?.id }) : null;
  const boardName = group?.name ?? institution;
  // The whole field's shape, shared by every viewer, on the unfiltered net-worth board; a board's own, live.
  const snapshot =
    basis !== 'net_worth'
      ? null
      : byWorth === null
        ? await fieldSnapshot()
        : shapeOf(
            byWorth.map((r) => r.netWorthMicro),
            new Date(),
          );
  const search = q === null ? null : parseTraderSearch(q);
  const named = new Set(await matchingTraders(field, search?.name));
  // `is:bot` keeps the viewer's own row too, whatever else the query says: the board as you against the bots.
  const matches =
    search === null
      ? field
      : field.filter(
          (r) =>
            (search.bots === true && r.accountId === viewer?.account.id) ||
            (named.has(r) &&
              institutionsMatch(r.institutions, search) &&
              (search.bots === null || r.isBot === search.bots)),
        );
  events.log('leaderboard.read', { accountId: viewer?.account.id ?? null });

  const me = viewer?.account.id ?? null;
  const mine = me === null ? -1 : field.findIndex((r) => r.accountId === me);
  const focus = around === null ? mine : field.findIndex((r) => r.handle === around);
  const standing = (i: number) => standingOf(field, field[i].accountId, basis)?.percentAhead ?? null;

  // What is on screen: one page of the board or of the search, by default
  // the `?around=` trader's, else the first.
  const signedIn = viewer !== null;
  const pages = Math.max(1, Math.ceil(matches.length / PAGE));
  const focusAt = focus < 0 ? -1 : matches.indexOf(field[focus]);
  const page =
    requested === 0 && around !== null && focusAt >= 0
      ? Math.floor(focusAt / PAGE) + 1
      : Math.min(Math.max(1, requested), pages);
  const rows = matches.slice((page - 1) * PAGE, page * PAGE);
  const onScreen = rows.length;
  const mineShown = mine >= 0 && rows.includes(field[mine]);

  const href = (patch: Record<string, string | null>) => {
    const params = new URLSearchParams();
    const all = {
      basis: basis === 'net_worth' ? null : basis,
      institution,
      group: group?.id ?? null,
      q,
      around,
      ...patch,
    };
    for (const [k, v] of Object.entries(all)) if (v) params.set(k, v);
    const s = params.toString();
    return s ? `/leaderboard?${s}` : '/leaderboard';
  };
  const where = group ? ` in ${group.name}` : institution ? ` at ${institution}` : '';
  // The bots on the global board, circled on Figure 1 only when the search asks for them (`is:bot`).
  const bots = board || search?.bots !== true ? [] : field.filter((r) => r.isBot);
  // The best figure in each column over the whole board, set in bold as a results table sets it.
  const best = bestOf(field);

  // The title names the board, and is how another is chosen.
  const picker = (
    <BoardPicker
      current={{
        label: boardName ?? 'Global',
        href: group ? groupPath(group.id) : institution ? institutionPath(institution) : '/leaderboard',
      }}
      mine={[
        { section: null, options: [{ key: 'everyone', label: 'Global', href: '/leaderboard' }] },
        {
          section: 'Your institutions',
          options: (viewer?.account.institutions ?? []).map((name) => ({
            key: `i:${name}`,
            label: name,
            href: institutionPath(name),
          })),
        },
        {
          section: 'Your reading groups',
          options: myGroups.map((g) => ({
            key: `g:${g.group.id}`,
            label: g.group.name,
            href: groupPath(g.group.id),
            note: String(g.memberCount),
          })),
        },
      ]}
      institutions={allInstitutions.map((i) => ({
        key: `i:${i.name}`,
        label: i.name,
        href: institutionPath(i.name),
        note: String(i.traders),
      }))}
    />
  );

  return (
    <main className={ui.page}>
      {board ? (
        <TitleBlock
          title={<>{picker} leaderboard</>}
          byline={
            <Authors
              authors={(group ? members! : byWorth!).map((m) => ({
                name: m.displayName,
                href: `/people/${encodeURIComponent(m.handle)}`,
                isBot: m.isBot,
                affiliations: m.institutions,
              }))}
              affiliationHref={institutionPath}
            />
          }
          abstract={group?.description}
        >
          {group && role && viewer && (
            <GroupActions
              group={{ id: group.id, name: group.name, description: group.description, inviteCode: group.inviteCode }}
              role={role}
              viewerHandle={viewer.account.handle}
              members={members!.map((m) => ({
                handle: m.handle,
                displayName: m.displayName,
                role: m.accountId === group.adminAccountId ? 'admin' : 'member',
              }))}
            />
          )}
        </TitleBlock>
      ) : (
        <TitleBlock title={<>{picker} leaderboard</>} />
      )}
      <form action="/leaderboard" method="get" role="search" className="flex gap-2">
        {basis !== 'net_worth' && <input type="hidden" name="basis" value={basis} />}
        {institution && <input type="hidden" name="institution" value={institution} />}
        {group && <input type="hidden" name="group" value={group.id} />}
        <input
          type="search"
          name="q"
          defaultValue={q ?? ''}
          maxLength={SEARCH_MAX_LENGTH}
          aria-label="Search traders"
          placeholder="Find a trader by name, institution:eth or is:bot"
          className="min-w-0 flex-1 border border-rule bg-card px-2 py-1.5 font-sans text-sm leading-[normal] placeholder:text-faint narrow:text-base focus:border-frame focus:outline-none"
        />
        <button
          type="submit"
          className="cursor-pointer border border-rule bg-rule-soft px-3.5 font-sans text-sm font-semibold text-ink"
        >
          Search
        </button>
      </form>

      {search && search.errors.length > 0 && (
        <div className="mt-2 font-sans text-[13px] text-down">Ignored: {search.errors.join('; ')}</div>
      )}

      {/* Where the viewer stands, and "+ New group" at the right of its first line. */}
      <div className="mt-2 flex items-start justify-between gap-4 font-sans text-[13px]">
        <div className="flex min-w-0 flex-col gap-0.5 text-muted">
          {mine >= 0 ? (
            <span>
              {(mine !== focus || !mineShown) && (
                <>
                  {' '}
                  <Link href={`${href({ around: field[mine].handle, q: null, page: null })}#focus`}>show me</Link>
                </>
              )}
            </span>
          ) : viewer ? (
            <span>
              {group && role === null
                ? 'You are not in this group.'
                : institution && !viewer.account.institutions.includes(institution)
                  ? `You are not at ${institution}.`
                  : basis === 'settled_pnl'
                    ? 'You are not on this board yet: it counts settled markets only.'
                    : 'You are not on this board.'}
            </span>
          ) : null}
          {around !== null &&
            (focus >= 0 ? (
              focus !== mine && (
                <span>
                  @{around}
                  {where}
                  {standing(focus) !== null && <>: {standingBand(standing(focus)!)} of traders</>}
                </span>
              )
            ) : (
              <span>
                No trader @{around} on this board{where}.
              </span>
            ))}
          {q && (
            <span>
              {matches.length.toLocaleString('en')} {matches.length === 1 ? 'trader' : 'traders'} match “{q}”.{' '}
              <Link href={href({ q: null, page: null })}>clear</Link>
            </span>
          )}
        </div>
        {viewer && (
          <NewGroupButton
            className={`${ui.linkBtn} shrink-0`}
            label={group ? '+ Create another reading group' : '+ Create reading group'}
          />
        )}
      </div>

      {snapshot && (
        <FieldCurve
          field={snapshot}
          of={
            group
              ? `the ${snapshot.worthsMicro.length.toLocaleString('en')} members of ${group.name}`
              : institution
                ? `the ${snapshot.worthsMicro.length.toLocaleString('en')} traders at ${institution}`
                : undefined
          }
          you={mine >= 0 ? field[mine].netWorthMicro : null}
          label={mine >= 0 ? (standing(mine) === null ? 'you' : `you, ${standingBand(standing(mine)!)}`) : null}
          other={
            focus >= 0 && focus !== mine
              ? {
                  handle: field[focus].handle,
                  worth: field[focus].netWorthMicro,
                  label: `@${field[focus].handle}${standing(focus) === null ? '' : `, ${standingBand(standing(focus)!)}`}`,
                }
              : null
          }
          marks={bots.map((r) => ({ handle: r.handle, worth: r.netWorthMicro }))}
        />
      )}

      {onScreen === 0 ? (
        <div className={ui.empty}>
          {q
            ? `No traders${where} match “${q}”.`
            : board
              ? `Nobody${where} is on this board yet.`
              : basis === 'settled_pnl'
                ? 'No markets have settled yet.'
                : 'No traders yet.'}
        </div>
      ) : (
        <PnlToggleProvider>
          <div className={ui.tableScroll}>
            <table className={ui.table}>
              {/* A paper's table caption sits above the table, its figure captions below. */}
              <caption className={ui.tableCaption}>
                <b>Table 1.</b> Traders{where}
                {basis === 'net_worth' ? ' ranked by net worth' : ' ranked by settled profit'}
                {q ? `, matching “${q}”` : ''}.{signedIn && ' Column leaders are bold.'}
              </caption>
              <thead>
                <tr>
                  <th className={ui.th()}>#</th>
                  <th className={ui.th()}>Trader</th>
                  <th className={`${ui.th()}`}>Institutions</th>
                  {signedIn && (
                    <th className={ui.th(true)}>
                      Net worth<sup className={ui.mark}>a</sup>
                    </th>
                  )}
                  <th className={ui.th(true)}>
                    {signedIn ? (
                      <>
                        <PnlToggleHeading label="Unrealized P/L" />
                        <sup className={ui.mark}>b</sup>
                      </>
                    ) : (
                      'Unrealized P/L'
                    )}
                  </th>
                </tr>
              </thead>
              <tbody>
                <Rows
                  rows={rows}
                  me={me}
                  best={best}
                  money={signedIn}
                  focus={focus >= 0 ? field[focus].accountId : null}
                  institutionHref={(name) => href({ institution: name, group: null, around: null, page: null })}
                  signInHref={authHref('/signin', href({}))}
                />
              </tbody>
            </table>
          </div>
        </PnlToggleProvider>
      )}
      {onScreen > 0 && signedIn && (
        <TableNotes
          notes={[
            ['a', 'Cash plus the proceeds from selling all holdings now.'],
            ['b', <>Click the heading to toggle between % and absolute.</>],
          ]}
        />
      )}
      {!signedIn && onScreen > 0 && (
        <p className="mt-2 font-sans text-[13px] text-muted">
          <Link href={authHref('/signin', href({}))}>Sign in</Link> to see net worth and P/L, and where you stand.
        </p>
      )}

      {pages > 1 && <Pager page={page} pages={pages} href={(p) => href({ page: String(p) })} />}
      {group && groupReading && (
        <ReadingListTable
          groupId={group.id}
          initial={groupReading}
          canEdit={role !== null}
          signedIn={signedIn}
          tableNumber={onScreen > 0 ? 2 : 1}
        />
      )}
    </main>
  );
}

type Best = { netWorth: bigint | null; unrealized: bigint | null; unrealizedPct: string | null };

/**
 * Each column's highest figure on the board, or null when nobody is above
 * zero: a column of zeros has no best, and a loss is never set as one.
 */
function bestOf(field: readonly LeaderboardRow[]): Best {
  const max = (pick: (r: LeaderboardRow) => bigint) => {
    const m = field.reduce<bigint | null>((acc, r) => (acc === null || pick(r) > acc ? pick(r) : acc), null);
    return m !== null && m > 0n ? m : null;
  };
  // The best gain as a share of its base, compared as fractions in integers: a/b > c/d ⇔ a·d > c·b (bases > 0).
  const pct = field.reduce<LeaderboardRow | null>(
    (acc, r) =>
      r.openCostMicro > 0n &&
      r.unrealizedPnlMicro > 0n &&
      (acc === null || r.unrealizedPnlMicro * acc.openCostMicro > acc.unrealizedPnlMicro * r.openCostMicro)
        ? r
        : acc,
    null,
  );
  return {
    netWorth: max((r) => r.netWorthMicro),
    unrealized: max((r) => r.unrealizedPnlMicro),
    unrealizedPct: pct?.accountId ?? null,
  };
}

/** Bold when `v` is its column's best. */
function bold(v: bigint, best: bigint | null): string {
  return v === best ? 'font-bold' : '';
}

/** A page of the board. */
function Rows({
  rows,
  me,
  best,
  money,
  focus,
  institutionHref,
  signInHref,
}: {
  rows: LeaderboardRow[];
  me: string | null;
  best: Best;
  /** Whether net worth is shown and P/L is real, not a blurred placeholder: signed-in viewers only. */
  money: boolean;
  focus: string | null;
  institutionHref: (name: string) => string;
  /** Where a held-back figure links: sign-in, back to this board. */
  signInHref: string;
}) {
  return (
    <>
      {rows.map((r) => {
        const highlight = r.accountId === me || r.accountId === focus;
        return (
          <tr
            key={r.accountId}
            id={r.accountId === focus ? 'focus' : undefined}
            className={highlight ? 'bg-highlight' : ''}
          >
            <td className={`${ui.td} font-mono text-[13px]`}>{r.rank}</td>
            <td className={ui.td}>
              <Link href={`/people/${encodeURIComponent(r.handle)}`} className="text-ink">
                {r.displayName}
              </Link>
              {r.isBot && <span className={ui.badge}>bot</span>}
              {r.accountId === me && <span className="ml-1 font-sans text-xs text-muted">(you)</span>}
            </td>
            <td className={`${ui.td} text-muted`}>
              {r.institutions.map((name, i) => (
                <span key={name}>
                  {i > 0 && '; '}
                  <Link href={institutionHref(name)} className="text-muted" title={`Rank ${name} among itself`}>
                    {name}
                  </Link>
                </span>
              ))}
            </td>
            {money ? (
              <>
                <td className={`${ui.td} ${ui.num} ${bold(r.netWorthMicro, best.netWorth)}`}>{rep(r.netWorthMicro)}</td>
                <td className={`${ui.td} ${ui.num} ${ui.pnl(r.unrealizedPnlMicro)}`}>
                  <Pnl
                    micro={r.unrealizedPnlMicro}
                    base={r.openCostMicro}
                    best={{
                      absolute: r.unrealizedPnlMicro === best.unrealized,
                      percent: r.accountId === best.unrealizedPct,
                    }}
                  />
                </td>
              </>
            ) : (
              <td className={`${ui.td} ${ui.num}`}>
                <Blurred signInHref={signInHref}>{`+???.?? ${REP}`}</Blurred>
              </td>
            )}
          </tr>
        );
      })}
    </>
  );
}

/**
 * A figure held back from a signed-out viewer: placeholders only, never the
 * number, blurred past reading. "Sign in to view" shows over it on hover or
 * focus, and it links to sign-in, so a tap on a phone goes there too.
 */
function Blurred({ children, signInHref }: { children: string; signInHref: string }) {
  return (
    <Link href={signInHref} aria-label="Sign in to view" className="group relative inline-block no-underline">
      <span aria-hidden className="inline-block blur-[4px] select-none text-ink">
        {children}
      </span>
      <span
        aria-hidden
        className="pointer-events-none absolute bottom-full right-0 mb-1 hidden whitespace-nowrap border border-frame bg-card px-2 py-1 font-sans text-xs text-ink shadow-sm group-hover:block group-focus-visible:block"
      >
        Sign in to view
      </span>
    </Link>
  );
}
