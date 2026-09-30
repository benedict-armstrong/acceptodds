import Link from 'next/link';
import { headers } from 'next/headers';
import { Pager } from '@/components/Pager';
import { FieldCurve } from '@/components/FieldCurve';
import { TableNotes } from '@/components/TableNotes';
import { TitleBlock } from '@/components/TitleBlock';
import { ui } from '@/components/ui';
import { rep, signedRep } from '@/lib/format';
import { leaderboardSegments } from '@/lib/leaderboard';
import { normalizeSearch, SEARCH_MAX_LENGTH } from '@/lib/search';
import { viewerFromHeaders } from '@/server/auth';
import * as events from '@/server/events';
import { fieldSnapshot } from '@/server/field-snapshot';
import {
  leaderboardStandings,
  matchingTraders,
  standingOf,
  type LeaderboardBasis,
  type LeaderboardRow,
} from '@/server/views';

export const dynamic = 'force-dynamic';

const TABS: { basis: LeaderboardBasis; label: string }[] = [
  { basis: 'net_worth', label: 'net worth' },
  { basis: 'settled_pnl', label: 'settled profit' },
];

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
 * board (`?page=`). `?institution=` ranks one institution among itself;
 * `?q=` finds traders by name, each at their rank on the board.
 */
export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const basis: LeaderboardBasis = one(sp.basis) === 'settled_pnl' ? 'settled_pnl' : 'net_worth';
  const institution = one(sp.institution)?.trim() || null;
  const q = normalizeSearch(one(sp.q));
  const around = one(sp.around)?.trim() || null;
  const requested = Math.max(0, Number.parseInt(one(sp.page) ?? '0', 10) || 0);

  const viewer = await viewerFromHeaders(await headers());
  const field = await leaderboardStandings({ basis, institution });
  // The whole field's shape, shared by every viewer: only on the unfiltered net-worth board it describes.
  const snapshot = basis === 'net_worth' && institution === null ? await fieldSnapshot() : null;
  const matches = await matchingTraders(field, q);
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
    const all = { basis: basis === 'net_worth' ? null : basis, institution, q, around, ...patch };
    for (const [k, v] of Object.entries(all)) if (v) params.set(k, v);
    const s = params.toString();
    return s ? `/leaderboard?${s}` : '/leaderboard';
  };
  const where = institution ? ` at ${institution}` : '';
  // The best figure in each column over the whole board, set in bold as a results table sets it.
  const best = bestOf(field);

  return (
    <main className={ui.page}>
      <TitleBlock title="Leaderboard" />
      <div className="flex flex-wrap items-baseline gap-x-4.5">
        <span className="flex gap-3 font-sans text-[13px] text-muted">
          {TABS.map((t) => (
            <Link key={t.basis} href={href({ basis: t.basis === 'net_worth' ? null : t.basis })} className={t.basis === basis ? ui.on : ''}>
              {t.label}
            </Link>
          ))}
        </span>
        <span className="flex-1" />
        {(institution || viewer?.account.institutions.length) && (
          <span className="flex gap-3 font-sans text-[13px] text-muted">
            <Link href={href({ institution: null, around: null })} className={institution === null ? ui.on : ''}>
              everyone
            </Link>
            {[...new Set([...(viewer?.account.institutions ?? []), institution])].filter((i): i is string => !!i).map((i) => (
              <Link key={i} href={href({ institution: i, around: null })} className={i === institution ? ui.on : ''}>
                {i}
              </Link>
            ))}
          </span>
        )}
      </div>

      <form action="/leaderboard" method="get" role="search" className="mt-2 flex gap-2">
        {basis !== 'net_worth' && <input type="hidden" name="basis" value={basis} />}
        {institution && <input type="hidden" name="institution" value={institution} />}
        <input
          type="search"
          name="q"
          defaultValue={q ?? ''}
          maxLength={SEARCH_MAX_LENGTH}
          aria-label="Search traders"
          placeholder="Find a trader by name or handle"
          className="min-w-0 flex-1 border border-rule bg-card px-2 py-1.5 font-sans text-sm leading-[normal] placeholder:text-faint focus:border-frame focus:outline-none"
        />
        <button type="submit" className="cursor-pointer border border-rule bg-rule-soft px-3.5 font-sans text-sm font-semibold text-ink">
          Search
        </button>
      </form>

      <div className="mt-2 flex flex-col gap-0.5 font-sans text-[13px] text-muted">
        {mine >= 0 ? (
          <span>
            You: <span className="font-semibold text-ink">#{field[mine].rank}</span> of {field.length.toLocaleString('en')}
            {where}
            {standing(mine) !== null && <> · ahead of {standing(mine)}% of traders</>}
            {mine !== focus && (
              <>
                {' '}
                · <Link href={`${href({ around: null, q: null, page: null })}#focus`}>show me</Link>
              </>
            )}
          </span>
        ) : viewer ? (
          <span>
            {institution && !viewer.account.institutions.includes(institution)
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
                @{around}: <span className="font-semibold text-ink">#{field[focus].rank}</span> of{' '}
                {field.length.toLocaleString('en')}
                {where}
                {standing(focus) !== null && <> · ahead of {standing(focus)}% of traders</>}
              </span>
            )
          ) : (
            <span>No trader @{around} on this board{where}.</span>
          ))}
        {q && (
          <span>
            {matches.length.toLocaleString('en')} {matches.length === 1 ? 'trader' : 'traders'} match “{q}” ·{' '}
            <Link href={href({ q: null, page: null })}>clear</Link>
          </span>
        )}
      </div>

      {snapshot && (
        <FieldCurve
          field={snapshot}
          you={mine >= 0 ? field[mine].netWorthMicro : null}
          label={mine >= 0 ? (standing(mine) === null ? 'you' : `you · ahead of ${standing(mine)}%`) : null}
          other={
            focus >= 0 && focus !== mine
              ? {
                handle: field[focus].handle,
                worth: field[focus].netWorthMicro,
                label: `@${field[focus].handle}${standing(focus) === null ? '' : ` · ahead of ${standing(focus)}%`}`,
              }
              : null
          }
        />
      )}

      {onScreen === 0 ? (
        <div className={ui.empty}>
          {q
            ? `No traders${where} match “${q}”.`
            : institution
              ? `Nobody${where} is on this board yet.`
              : basis === 'settled_pnl'
                ? 'No markets have settled yet.'
                : 'No traders yet.'}
        </div>
      ) : (
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
              <th className={`${ui.th()} narrow:hidden`}>Institutions</th>
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
                institutionHref={(name) => href({ institution: name, around: null, page: null })}
              />
            ))}
          </tbody>
        </table>
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
  return { netWorth: max((r) => r.netWorthMicro), unrealized: max((r) => r.unrealizedPnlMicro), settled: max((r) => r.settledPnlMicro) };
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
          <tr key={r.accountId} id={r.accountId === focus ? 'focus' : undefined} className={highlight ? 'bg-highlight' : ''}>
            <td className={`${ui.td} font-mono text-[13px]`}>{r.rank}</td>
            <td className={ui.td}>
              <Link href={`/people/${encodeURIComponent(r.handle)}`} className="text-ink">
                {r.displayName}
              </Link>
              {r.isBot && <span className={ui.badge}>bot</span>}
              {r.accountId === me && <span className="ml-1 font-sans text-xs text-muted">(you)</span>}
            </td>
            <td className={`${ui.td} text-muted narrow:hidden`}>
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
            <td className={`${ui.td} ${ui.num} ${ui.pnl(r.unrealizedPnlMicro)} ${bold(r.unrealizedPnlMicro, best.unrealized)}`}>
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
