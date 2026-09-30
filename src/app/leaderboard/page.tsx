import Link from 'next/link';
import { headers } from 'next/headers';
import { Pager } from '@/components/Pager';
import { StandingChart } from '@/components/StandingChart';
import { ui } from '@/components/ui';
import { ago, rep, REP, signedRep } from '@/lib/format';
import { leaderboardSegments } from '@/lib/leaderboard';
import { microToFloat } from '@/lib/money';
import { normalizeSearch, SEARCH_MAX_LENGTH } from '@/lib/search';
import { viewerFromHeaders } from '@/server/auth';
import * as events from '@/server/events';
import { fieldSnapshot, type FieldSnapshot } from '@/server/field-snapshot';
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

  return (
    <main className={ui.page}>
      <div className="flex flex-wrap items-baseline gap-x-4.5">
        <h2 className={ui.groupHeading}>Leaderboard</h2>
        <span className="flex gap-3 font-sans text-[13px] text-muted">
          {TABS.map((t) => (
            <Link key={t.basis} href={href({ basis: t.basis === 'net_worth' ? null : t.basis })} className={t.basis === basis ? ui.on : ''}>
              {t.label}
            </Link>
          ))}
        </span>
        <span className="flex-1" />
        {(institution || viewer?.account.institutionName) && (
          <span className="flex gap-3 font-sans text-[13px] text-muted">
            <Link href={href({ institution: null, around: null })} className={institution === null ? ui.on : ''}>
              everyone
            </Link>
            {[...new Set([viewer?.account.institutionName, institution])].filter((i): i is string => !!i).map((i) => (
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
            {institution && viewer.account.institutionName !== institution
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
          <thead>
            <tr>
              <th className={ui.th()}>#</th>
              <th className={ui.th()}>Trader</th>
              <th className={`${ui.th()} narrow:hidden`}>Institution</th>
              <th className={ui.th(true)} title="Cash plus what selling every open holding now would pay">
                Net worth
              </th>
              <th className={ui.th(true)} title="On markets not yet settled, if sold now">
                Unrealized
              </th>
              <th className={ui.th(true)} title="On settled markets">
                Settled
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
                focus={focus >= 0 ? field[focus].accountId : null}
                institutionHref={(name) => href({ institution: name, around: null, page: null })}
              />
            ))}
          </tbody>
        </table>
      )}

      {onScreen < list.length && (
        <Pager
          page={page}
          pages={pages}
          label={compact ? 'all traders:' : undefined}
          href={(p) => href({ page: String(p) })}
        />
      )}

      {snapshot && (
        <FieldCurve
          field={snapshot}
          you={mine >= 0 ? field[mine].netWorthMicro : null}
          label={mine >= 0 ? (standing(mine) === null ? 'you' : `you · ahead of ${standing(mine)}%`) : null}
        />
      )}

      <p className={`${ui.fine} mb-3`}>
        Net worth is cash plus what selling every open holding right now would actually pay — not holdings marked at the
        current price, which a trader could inflate by pushing the price themselves. Unrealized is what selling now would
        make on markets not yet settled; settled is profit on markets that have resolved.
      </p>
    </main>
  );
}

/** Consecutive rows of the board, after a "…" row when they do not follow the rows above. */
function Segment({
  rows,
  gapBefore,
  me,
  focus,
  institutionHref,
}: {
  rows: LeaderboardRow[];
  gapBefore: boolean;
  me: string | null;
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
              {r.displayName}
              {r.isBot && <span className={ui.badge}>bot</span>}
              {r.accountId === me && <span className="ml-1 font-sans text-xs text-muted">(you)</span>}
            </td>
            <td className={`${ui.td} text-muted narrow:hidden`}>
              {r.institutionName && (
                <Link href={institutionHref(r.institutionName)} className="text-muted" title={`Rank ${r.institutionName} among itself`}>
                  {r.institutionName}
                </Link>
              )}
            </td>
            <td className={`${ui.td} ${ui.num}`}>{rep(r.netWorthMicro)}</td>
            <td className={`${ui.td} ${ui.num} ${ui.pnl(r.unrealizedPnlMicro)}`}>{signedRep(r.unrealizedPnlMicro)}</td>
            <td className={`${ui.td} ${ui.num} ${ui.pnl(r.settledPnlMicro)}`}>{signedRep(r.settledPnlMicro)}</td>
          </tr>
        );
      })}
    </>
  );
}

/** Micro-units as whole units, for plotting only: the chart never feeds back into money. */
const toUnits = (micro: bigint) => microToFloat(micro) / 1_000_000;

/**
 * The field's shape: the shared snapshot of every trader's net worth at
 * liquidation value (never a mark, §1.2) as a curve (`StandingChart`), the
 * viewer on it by their exact figure from this board, and the same figures
 * as a table. The snapshot may be a few minutes old and says so. Nothing for
 * a field of one.
 */
function FieldCurve({ field, you, label }: { field: FieldSnapshot; you: bigint | null; label: string | null }) {
  const worths = field.worthsMicro;
  if (worths.length < 2) return null;
  // Nearest-rank quantiles: real traders' figures, exact, never interpolated money.
  const at = (q: number) => worths[Math.round((worths.length - 1) * q)];
  const rows: [string, bigint][] = [
    ['Lowest', worths[0]],
    ['25th percentile', at(0.25)],
    ['Median', at(0.5)],
    ['75th percentile', at(0.75)],
    ['Highest', worths[worths.length - 1]],
  ];
  return (
    <section aria-label="The field">
      <h3 className={`${ui.subsection} mt-6 mb-1.5`}>The field</h3>
      <p className={ui.caption}>
        Net worth of all {worths.length.toLocaleString('en')} traders, if each sold everything now, as of{' '}
        {ago(field.computedAt)} ago.{you !== null && ' The shaded part is everyone below you.'}
      </p>
      <StandingChart
        curve={field.curve}
        domain={field.domain}
        values={worths.map(toUnits)}
        you={you === null ? null : toUnits(you)}
        label={label}
      />
      <details className="mt-1 font-sans text-xs text-muted">
        <summary className="cursor-pointer">the numbers</summary>
        <table className="mt-1">
          <tbody>
            {rows.map(([name, v]) => (
              <tr key={name}>
                <td className="pr-4">{name}</td>
                <td className="text-right font-mono text-ink">
                  {rep(v)} {REP}
                </td>
              </tr>
            ))}
            {you !== null && (
              <tr>
                <td className="pr-4 font-semibold text-ink">You</td>
                <td className="text-right font-mono font-semibold text-ink">
                  {rep(you)} {REP}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </details>
    </section>
  );
}
