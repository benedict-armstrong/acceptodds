import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { Authors } from '@/components/Authors';
import { BoardPicker } from '@/components/BoardPicker';
import { GroupActions, NewGroupButton } from '@/components/Groups';
import { Pager } from '@/components/Pager';
import { FieldCurve } from '@/components/FieldCurve';
import { TableNotes } from '@/components/TableNotes';
import { TitleBlock } from '@/components/TitleBlock';
import { ui } from '@/components/ui';
import { rep, signedRep } from '@/lib/format';
import { leaderboardSegments, standingBand } from '@/lib/leaderboard';
import { groupPath, institutionPath } from '@/lib/links';
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

/** Traders per page when paging through the whole board or a search. */
const PAGE = 50;
/** The compact view: the top of the board, and this many either side of the viewer. */
const TOP = 10;
const RADIUS = 2;

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
 * Opens compact: the top ten, then the viewer (or `?around=<handle>`, where a
 * people search leads) with two either side, then a pager into the whole
 * board (`?page=`). `?institution=` ranks one institution among itself,
 * `?group=` one group (#25); either opens like a paper, its members as the
 * author line, with its own Figure 1. `?q=` finds traders by name and
 * `institution:` (`lib/trader-query.ts`), each at their rank on the board.
 * The title names the board — "Global leaderboard" — and its name is a
 * find box over the boards (`BoardPicker`): global, the viewer's
 * institutions and groups, and any institution by name. "+ New group" sits
 * under the search.
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
  const matches = (await matchingTraders(field, search?.name)).filter(
    (r) => search === null || institutionsMatch(r.institutions, search),
  );
  events.log('leaderboard.read', { accountId: viewer?.account.id ?? null });

  const me = viewer?.account.id ?? null;
  const mine = me === null ? -1 : field.findIndex((r) => r.accountId === me);
  const focus = around === null ? mine : field.findIndex((r) => r.handle === around);
  const standing = (i: number) => standingOf(field, field[i].accountId, basis)?.percentAhead ?? null;

  // What is on screen: the compact view as segments of the board, or one page
  // of the board or of the search.
  const compact = q === null && requested === 0;
  const list = compact ? field : matches;
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  const page = compact ? 0 : Math.min(Math.max(1, requested), pages);
  const segments: LeaderboardRow[][] = compact
    ? leaderboardSegments(field.length, focus < 0 ? null : focus, TOP, RADIUS).map(([s, e]) => field.slice(s, e))
    : [list.slice((page - 1) * PAGE, page * PAGE)];
  const onScreen = segments.reduce((n, s) => n + s.length, 0);

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
          section: 'Your groups',
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
          placeholder="Find a trader by name, or institution:eth"
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
              {mine !== focus && (
                <>
                  {' '}
                  <Link href={`${href({ around: null, q: null, page: null })}#focus`}>show me</Link>
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
        {viewer && <NewGroupButton className={`${ui.linkBtn} shrink-0`} />}
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
        <div className={ui.tableScroll}>
          <table className={ui.table}>
            {/* A paper's table caption sits above the table, its figure captions below. */}
            <caption className={ui.tableCaption}>
              <b>Table 1.</b> Traders{where}
              {basis === 'net_worth' ? ' by net worth, if each sold everything now' : ' by profit on settled markets'}
              {q ? `, matching “${q}”` : ''}. The best figure in each column is in bold.
            </caption>
            <thead>
              <tr>
                <th className={ui.th()}>#</th>
                <th className={ui.th()}>Trader</th>
                <th className={`${ui.th()}`}>Institutions</th>
                <th className={ui.th(true)}>
                  Net worth<sup className={ui.mark}>a</sup>
                </th>
                <th className={ui.th(true)}>
                  Unrealized<sup className={ui.mark}>b</sup>
                </th>
                <th className={ui.th(true)}>
                  Settled<sup className={ui.mark}>c</sup>
                </th>
              </tr>
            </thead>
            <tbody>
              {segments.map((segment, i) => (
                <Segment
                  key={segment[0]?.accountId ?? i}
                  rows={segment}
                  gapBefore={i > 0}
                  me={me}
                  best={best}
                  focus={focus >= 0 ? field[focus].accountId : null}
                  institutionHref={(name) => href({ institution: name, group: null, around: null, page: null })}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {onScreen > 0 && (
        <TableNotes
          notes={[
            [
              'a',
              'Cash plus what selling every open holding right now would actually pay — not holdings marked at the current price, which a trader could inflate by pushing the price themselves.',
            ],
            ['b', 'What selling now would make on markets not yet settled.'],
            ['c', 'Profit on markets that have resolved.'],
          ]}
        />
      )}

      {onScreen < list.length && (
        <Pager
          page={page}
          pages={pages}
          label={compact ? 'all traders:' : undefined}
          href={(p) => href({ page: String(p) })}
        />
      )}
    </main>
  );
}

type Best = { netWorth: bigint | null; unrealized: bigint | null; settled: bigint | null };

/**
 * Each column's highest figure on the board, or null when nobody is above
 * zero: a column of zeros has no best, and a loss is never set as one.
 */
function bestOf(field: readonly LeaderboardRow[]): Best {
  const max = (pick: (r: LeaderboardRow) => bigint) => {
    const m = field.reduce<bigint | null>((acc, r) => (acc === null || pick(r) > acc ? pick(r) : acc), null);
    return m !== null && m > 0n ? m : null;
  };
  return {
    netWorth: max((r) => r.netWorthMicro),
    unrealized: max((r) => r.unrealizedPnlMicro),
    settled: max((r) => r.settledPnlMicro),
  };
}

/** Bold when `v` is its column's best. */
function bold(v: bigint, best: bigint | null): string {
  return v === best ? 'font-bold' : '';
}

/** Consecutive rows of the board, after a "…" row when they do not follow the rows above. */
function Segment({
  rows,
  gapBefore,
  me,
  best,
  focus,
  institutionHref,
}: {
  rows: LeaderboardRow[];
  gapBefore: boolean;
  me: string | null;
  best: Best;
  focus: string | null;
  institutionHref: (name: string) => string;
}) {
  return (
    <>
      {gapBefore && (
        <tr aria-hidden>
          <td colSpan={6} className={`${ui.td} text-center text-muted`}>
            …
          </td>
        </tr>
      )}
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
            <td className={`${ui.td} ${ui.num} ${bold(r.netWorthMicro, best.netWorth)}`}>{rep(r.netWorthMicro)}</td>
            <td
              className={`${ui.td} ${ui.num} ${ui.pnl(r.unrealizedPnlMicro)} ${bold(r.unrealizedPnlMicro, best.unrealized)}`}
            >
              {signedRep(r.unrealizedPnlMicro)}
            </td>
            <td className={`${ui.td} ${ui.num} ${ui.pnl(r.settledPnlMicro)} ${bold(r.settledPnlMicro, best.settled)}`}>
              {signedRep(r.settledPnlMicro)}
            </td>
          </tr>
        );
      })}
    </>
  );
}
