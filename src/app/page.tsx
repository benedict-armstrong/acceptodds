import Link from 'next/link';
import { headers } from 'next/headers';
import { FollowStar } from '@/components/FollowStar';
import { Sparkline } from '@/components/Sparkline';
import { ui } from '@/components/ui';
import { day, pct, rep } from '@/lib/format';
import { likelihoodClass, marketLikelihood } from '@/lib/likelihood';
import { normalizeSearch, SEARCH_MAX_LENGTH } from '@/lib/search';
import { viewerFromHeaders } from '@/server/auth';
import * as events from '@/server/events';
import { followedListingIds } from '@/server/follows';
import {
  browseListings,
  MARKET_SORTS,
  marketKinds,
  sparklines,
  type BrowseRow,
  type BrowseSort,
} from '@/server/views';

export const dynamic = 'force-dynamic';

/** The selected filter link. */
const ON = ui.on;

const STATUSES = ['open', 'closed', 'settled', 'all'] as const;
type Status = (typeof STATUSES)[number];

/** The home page shows at most this many rows; a search says "N+" when it hits it. */
const LIMIT = 200;

/** The venue shown first. Opaque to the platform: it is a `kind` string. */
function defaultKind(): string {
  return process.env.DEFAULT_MARKET_KIND ?? 'ICLR 2027';
}

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const kinds = await marketKinds();
  const wanted = one(sp.kind);
  // ?kind=all shows every venue; otherwise the requested one, else the default
  // venue if it has markets, else everything.
  const kind =
    wanted === 'all' ? null : wanted ?? (kinds.some((k) => k.kind === defaultKind()) ? defaultKind() : null);
  const status: Status = (STATUSES as readonly string[]).includes(one(sp.status) ?? '') ? (one(sp.status) as Status) : 'open';
  // A search keeps the venue and status filters (the form carries them) and
  // sorts by relevance unless another sort is asked for.
  const q = normalizeSearch(one(sp.q));
  const sorts: readonly BrowseSort[] = q ? ['relevance', ...MARKET_SORTS] : MARKET_SORTS;
  const sort: BrowseSort = (sorts as readonly string[]).includes(one(sp.sort) ?? '')
    ? (one(sp.sort) as BrowseSort)
    : q
      ? 'relevance'
      : 'closing';

  // One row per listing (a paper), read from its main market; plus one per
  // market that belongs to no listing.
  const viewer = await viewerFromHeaders(await headers());
  // ?following=1: only papers the signed-in viewer follows.
  const onlyFollowed = viewer !== null && one(sp.following) === '1';
  const rows = await browseListings({ kind, status, sort, q, limit: LIMIT, followedBy: onlyFollowed ? viewer.account.id : null });
  const sparks = await sparklines(rows);
  const followed = viewer ? await followedListingIds(viewer.account.id) : new Set<string>();
  events.log('market.list', { accountId: viewer?.account.id ?? null });

  // Filter links keep the search; `q: ''` drops it (and its relevance sort).
  const href = (patch: Record<string, string>) => {
    const params = new URLSearchParams({
      kind: kind ?? 'all',
      status,
      sort,
      ...(q ? { q } : {}),
      ...(onlyFollowed ? { following: '1' } : {}),
      ...patch,
    });
    if (!params.get('q')) {
      params.delete('q');
      if (params.get('sort') === 'relevance') params.delete('sort');
    }
    if (params.get('following') === '0') params.delete('following');
    return `/?${params}`;
  };
  const filtered = kind !== null || status !== 'all';

  // Grouped by closing day only when sorted by it; otherwise one flat list.
  const groups: [string, BrowseRow[]][] = [];
  for (const r of rows) {
    const key = sort === 'closing' ? heading(r) : '';
    const g = groups.find(([k]) => k === key);
    if (g) g[1].push(r);
    else groups.push([key, [r]]);
  }

  return (
    <main className={ui.page}>
      {/* A plain GET form, so search works without JavaScript. */}
      <form action="/" method="get" role="search" className="mt-3.5 flex gap-2">
        <input type="hidden" name="kind" value={kind ?? 'all'} />
        <input type="hidden" name="status" value={status} />
        {onlyFollowed && <input type="hidden" name="following" value="1" />}
        <input
          type="search"
          name="q"
          defaultValue={q ?? ''}
          maxLength={SEARCH_MAX_LENGTH}
          aria-label="Search papers"
          placeholder='Search titles, authors, abstracts — "a phrase", -without'
          className="min-w-0 flex-1 border border-rule bg-card px-2 py-1.5 font-sans text-sm leading-[normal] placeholder:text-faint focus:border-frame focus:outline-none"
        />
        <button
          type="submit"
          className="cursor-pointer border border-rule bg-rule-soft px-3.5 font-sans text-sm font-semibold text-ink"
        >
          Search
        </button>
      </form>

      {q && (
        <div className="mt-2 font-sans text-[13px] text-muted">
          {rows.length === LIMIT ? `${LIMIT}+` : rows.length} {rows.length === 1 ? 'result' : 'results'} for “{q}”
          {filtered && (
            <>
              {' '}
              in {kind ?? 'all venues'}
              {status !== 'all' && `, ${status}`} ·{' '}
              <Link href={href({ kind: 'all', status: 'all' })}>search everything</Link>
            </>
          )}{' '}
          · <Link href={href({ q: '' })}>clear</Link>
        </div>
      )}

      <div className="mt-2 mb-1 flex flex-wrap items-baseline gap-x-4.5 gap-y-1.5 font-sans text-[13px] text-muted">
        <span className="flex gap-3">
          {kinds.map((k) => (
            <Link key={k.kind} href={href({ kind: k.kind })} className={k.kind === kind ? ON : ''}>
              {k.kind}
            </Link>
          ))}
          <Link href={href({ kind: 'all' })} className={kind === null ? ON : ''}>
            all venues
          </Link>
        </span>
        <span className="flex-1" />
        {viewer && (
          <Link href={href({ following: onlyFollowed ? '0' : '1' })} className={onlyFollowed ? ON : ''}>
            ★ following
          </Link>
        )}
        <span className="flex gap-3">
          {STATUSES.map((s) => (
            <Link key={s} href={href({ status: s })} className={s === status ? ON : ''}>
              {s}
            </Link>
          ))}
        </span>
        <span className="flex gap-3">
          sort:
          {sorts.map((s) => (
            <Link key={s} href={href({ sort: s })} className={s === sort ? ON : ''}>
              {s}
            </Link>
          ))}
        </span>
      </div>

      {rows.length === 0 &&
        (q ? (
          <div className={ui.empty}>
            No {onlyFollowed ? 'papers you follow' : 'papers'} match “{q}”.
          </div>
        ) : onlyFollowed ? (
          <div className={ui.empty}>
            No {status === 'all' ? '' : status + ' '}papers you follow here. Star one with ☆ to follow it.
          </div>
        ) : (
          <div className={ui.empty}>Nothing {status === 'all' ? '' : status + ' '}here yet.</div>
        ))}

      {groups.map(([key, list]) => (
        <section key={key || 'all'}>
          {key && (
            <h2 className={ui.groupHeading}>
              {key} <span className="font-normal">({list.length})</span>
            </h2>
          )}
          {!key && <div className="h-3.5" />}
          {list.map((r) => {
            const look = likelihoodClass(marketLikelihood({ ...r.market, outcomes: r.outcomes }));
            const row = (
              <Link
                key={r.market.id}
                href={r.listing ? `/papers/${r.listing.slug}` : `/markets/${r.market.slug}`}
                className="grid min-w-0 flex-1 grid-cols-[3px_1fr_90px_90px_110px] items-center gap-x-3.5 border-b border-dotted border-rule-strong py-2 hover:bg-highlight hover:no-underline narrow:grid-cols-[3px_1fr_64px]"
              >
                <span className={`self-stretch ${look.bar}`} aria-hidden />
                <span className="leading-[1.35]">
                  {r.listing ? r.listing.title : r.market.question}
                  {r.listing && r.listing.authors.length > 0 && (
                    <span className="block font-sans text-xs text-muted">{authors(r.listing.authors)}</span>
                  )}
                </span>
                <span className="text-right font-mono text-xs text-muted narrow:hidden" title="volume">
                  {r.totalOrderCount > 0 ? `${rep(r.totalVolumeMicro, 0)} rep` : ''}
                </span>
                <span className="narrow:hidden" title={r.listing ? r.market.question : undefined}>
                  <Sparkline values={sparks.get(r.market.id) ?? []} />
                </span>
                <span className={`text-right font-mono text-sm ${look.text}`} title={r.listing ? r.market.question : undefined}>
                  {headline(r)}
                </span>
              </Link>
            );
            // A signed-in viewer gets a star beside each paper, outside the
            // row's link (a button may not sit inside an <a>).
            if (!viewer) return row;
            return (
              <div key={r.market.id} className="flex items-stretch">
                <span className="flex w-5 shrink-0 items-center border-b border-dotted border-rule-strong">
                  {r.listing && <FollowStar listingId={r.listing.id} following={followed.has(r.listing.id)} />}
                </span>
                {row}
              </div>
            );
          })}
        </section>
      ))}
    </main>
  );
}

/** "A, B, C et al." — enough to recognise a paper by. */
function authors(names: string[]): string {
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} et al.` : names.join(', ');
}

function heading(r: BrowseRow): string {
  if (r.market.status === 'settled') return 'Settled';
  if (r.market.status === 'closed') return 'Closed — awaiting resolution';
  return `Closing ${day(r.market.closesAt)}`;
}

/** Binary: the first outcome's price. More outcomes: the favourite, named. Settled: the winner. */
function headline(r: BrowseRow): React.ReactNode {
  if (r.market.status === 'settled') {
    return r.outcomes.find((o) => o.id === r.market.resolvedOutcomeId)?.label ?? 'settled';
  }
  if (r.outcomes.length === 2) return pct(r.outcomes[0].price);
  const top = [...r.outcomes].sort((a, b) => b.price - a.price)[0];
  return (
    <>
      <span className="font-serif text-sm">{top.label}</span> {pct(top.price)}
    </>
  );
}
