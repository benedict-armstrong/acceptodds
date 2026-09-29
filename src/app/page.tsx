import Link from 'next/link';
import { cookies, headers } from 'next/headers';
import { Collapsible } from '@/components/Collapsible';
import { MathText } from '@/components/MathText';
import { OutcomeBar } from '@/components/OutcomeBar';
import { Sparkline } from '@/components/Sparkline';
import { ui } from '@/components/ui';
import { pct, rep } from '@/lib/format';
import { marketHeadline } from '@/lib/headline';
import { likelihoodClass, marketLikelihood } from '@/lib/likelihood';
import { normalizeSearch, SEARCH_MAX_LENGTH } from '@/lib/search';
import { viewerFromHeaders } from '@/server/auth';
import * as events from '@/server/events';
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
/** Followed papers per page in the "Following" section; `?fpage=` pages it. */
const FOLLOWING_PAGE = 10;
/** The cookie remembering whether that section was left collapsed. */
const FOLLOWING_COOKIE = 'home_following_open';
/** Same for the "My positions" section. */
const POSITIONS_PAGE = 10;
const POSITIONS_COOKIE = 'home_positions_open';

/** The home page's sorts, default first. The venue's `closing` is not offered. */
const SORTS = MARKET_SORTS.filter((s) => s !== 'closing');
/** Sort keys shown under another name. The venue's `likelihood` is the headline (`lib/headline.ts`). */
const SORT_LABEL: Partial<Record<BrowseSort, string>> = { likelihood: 'acceptance' };

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
  const sorts: readonly BrowseSort[] = q ? ['relevance', ...SORTS] : SORTS;
  const sort: BrowseSort = (sorts as readonly string[]).includes(one(sp.sort) ?? '')
    ? (one(sp.sort) as BrowseSort)
    : q
      ? 'relevance'
      : SORTS[0];

  // One row per listing (a paper), read from its main market; plus one per
  // market that belongs to no listing.
  const viewer = await viewerFromHeaders(await headers());
  // ?following=1: only papers the signed-in viewer follows.
  const onlyFollowed = viewer !== null && one(sp.following) === '1';
  const rows = await browseListings({ kind, status, sort, q, limit: LIMIT, followedBy: onlyFollowed ? viewer.account.id : null });
  // The part of this list the viewer follows, pinned above it: same venue,
  // status and sort, paged on its own. Not while searching, nor when the list
  // is already only followed papers.
  const followedAll =
    viewer && !q && !onlyFollowed
      ? await browseListings({ kind, status, sort, limit: LIMIT, followedBy: viewer.account.id })
      : [];
  const fpages = Math.max(1, Math.ceil(followedAll.length / FOLLOWING_PAGE));
  const fpage = Math.min(fpages, Math.max(1, Number.parseInt(one(sp.fpage) ?? '1', 10) || 1));
  const followed = followedAll.slice((fpage - 1) * FOLLOWING_PAGE, fpage * FOLLOWING_PAGE);
  const followingOpen = (await cookies()).get(FOLLOWING_COOKIE)?.value !== '0';
  // Papers the viewer holds shares in. One row per paper already; those also
  // in "Following" are shown there only, so no paper is pinned twice.
  const followedIds = new Set(followedAll.map((r) => r.market.id));
  const heldAll =
    viewer && !q && !onlyFollowed
      ? (await browseListings({ kind, status, sort, limit: LIMIT, heldBy: viewer.account.id })).filter(
          (r) => !followedIds.has(r.market.id),
        )
      : [];
  // "All papers" is the rest: nothing pinned above is repeated below.
  const pinned = new Set([...followedIds, ...heldAll.map((r) => r.market.id)]);
  const rest = rows.filter((r) => !pinned.has(r.market.id));
  const hpages = Math.max(1, Math.ceil(heldAll.length / POSITIONS_PAGE));
  const hpage = Math.min(hpages, Math.max(1, Number.parseInt(one(sp.hpage) ?? '1', 10) || 1));
  const held = heldAll.slice((hpage - 1) * POSITIONS_PAGE, hpage * POSITIONS_PAGE);
  const positionsOpen = (await cookies()).get(POSITIONS_COOKIE)?.value !== '0';
  const sparks = await sparklines([...rows, ...followed, ...held]);
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
        <span className="flex gap-3">
          sort:
          {sorts.map((s) => (
            <Link key={s} href={href({ sort: s })} className={s === sort ? ON : ''}>
              {SORT_LABEL[s] ?? s}
            </Link>
          ))}
        </span>
        {/* Status and following, out of the way. A <details>, so it works without JavaScript. */}
        <details className="relative">
          <summary
            title="More filters: status, following"
            className="cursor-pointer list-none px-1 text-ink hover:text-accent [&::-webkit-details-marker]:hidden"
          >
            {[status !== 'open' && status, onlyFollowed && '★'].filter(Boolean).join(' · ')}
            {(status !== 'open' || onlyFollowed) && ' '}⋯
          </summary>
          <div className="absolute right-0 z-10 mt-1 flex min-w-32 flex-col gap-1 border border-frame bg-card px-3 py-2">
            {STATUSES.map((s) => (
              <Link key={s} href={href({ status: s })} className={s === status ? ON : ''}>
                {s}
              </Link>
            ))}
            {viewer && (
              <Link
                href={href({ following: onlyFollowed ? '0' : '1' })}
                className={`mt-1 border-t border-rule pt-1.5 ${onlyFollowed ? ON : ''}`}
              >
                ★ following
              </Link>
            )}
          </div>
        </details>
      </div>

      {rows.length === 0 &&
        (q ? (
          <div className={ui.empty}>
            No {onlyFollowed ? 'papers you follow' : 'papers'} match “{q}”.
          </div>
        ) : onlyFollowed ? (
          <div className={ui.empty}>
            No {status === 'all' ? '' : status + ' '}papers you follow here. Follow one with ☆ on its page.
          </div>
        ) : (
          <div className={ui.empty}>Nothing {status === 'all' ? '' : status + ' '}here yet.</div>
        ))}

      {followedAll.length > 0 && (
        <Collapsible
          id="following"
          cookie={FOLLOWING_COOKIE}
          open={followingOpen}
          className="group mt-3.5"
          summary={
            <summary className={`${ui.groupHeading} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}>
              <span className="inline-block w-3 group-open:rotate-90" aria-hidden>
                ›
              </span>
              Following <span className="font-normal">({followedAll.length})</span>
            </summary>
          }
        >
          {followed.map((r) => (
            <Row key={r.market.id} r={r} spark={sparks.get(r.market.id) ?? []} />
          ))}
          {fpages > 1 && (
            <div className="mt-1.5 flex justify-end gap-3 font-sans text-[13px] text-muted">
              {fpage > 1 && <Link href={`${href({ fpage: String(fpage - 1) })}#following`}>← prev</Link>}
              <span>
                page {fpage} of {fpages}
              </span>
              {fpage < fpages && <Link href={`${href({ fpage: String(fpage + 1) })}#following`}>next →</Link>}
            </div>
          )}
        </Collapsible>
      )}

      {heldAll.length > 0 && (
        <Collapsible
          id="positions"
          cookie={POSITIONS_COOKIE}
          open={positionsOpen}
          className="group mt-3.5"
          summary={
            <summary className={`${ui.groupHeading} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}>
              <span className="inline-block w-3 group-open:rotate-90" aria-hidden>
                ›
              </span>
              My positions <span className="font-normal">({heldAll.length})</span>
            </summary>
          }
        >
          {held.map((r) => (
            <Row key={r.market.id} r={r} spark={sparks.get(r.market.id) ?? []} />
          ))}
          {hpages > 1 && (
            <div className="mt-1.5 flex justify-end gap-3 font-sans text-[13px] text-muted">
              {hpage > 1 && <Link href={`${href({ hpage: String(hpage - 1) })}#positions`}>← prev</Link>}
              <span>
                page {hpage} of {hpages}
              </span>
              {hpage < hpages && <Link href={`${href({ hpage: String(hpage + 1) })}#positions`}>next →</Link>}
            </div>
          )}
        </Collapsible>
      )}

      <section>
        {followedAll.length > 0 || heldAll.length > 0 ? <h2 className={ui.groupHeading}>All papers</h2> : <div className="h-3.5" />}
        {rest.map((r) => (
          <Row key={r.market.id} r={r} spark={sparks.get(r.market.id) ?? []} />
        ))}
      </section>
    </main>
  );
}

/** One paper (or unlisted market) in a list. */
function Row({ r, spark }: { r: BrowseRow; spark: number[] }) {
  const look = likelihoodClass(marketLikelihood({ ...r.market, outcomes: r.outcomes }));
  return (
    <Link
      href={r.listing ? `/papers/${r.listing.slug}` : `/markets/${r.market.slug}`}
      className="grid grid-cols-[3px_1fr_90px_90px_110px] items-center gap-x-3.5 border-b border-dotted border-rule-strong py-2 hover:bg-highlight hover:no-underline narrow:grid-cols-[3px_1fr_64px]"
    >
      <span className={`self-stretch ${look.bar}`} aria-hidden />
      <span className="min-w-0 leading-[1.35]">
        {/* At most two lines; the whole title on hover. */}
        <span className="line-clamp-2" title={r.listing ? r.listing.title : r.market.question}>
          <MathText text={r.listing ? r.listing.title : r.market.question} />
        </span>
        {r.listing && r.listing.authors.length > 0 && (
          <span className="block font-sans text-xs text-muted">{authors(r.listing.authors)}</span>
        )}
      </span>
      <span className="text-right font-mono text-xs text-muted narrow:hidden" title="volume">
        {r.totalOrderCount > 0 ? `${rep(r.totalVolumeMicro, 0)} rep` : ''}
      </span>
      <span className="narrow:hidden" title={r.listing ? r.market.question : undefined}>
        <Sparkline values={spark} />
      </span>
      <span className={`text-right font-mono text-sm ${look.text}`} title={r.listing ? `${r.market.question} · chance of acceptance` : undefined}>
        {headline(r)}
      </span>
    </Link>
  );
}

/** "A, B, C et al." — enough to recognise a paper by. */
function authors(names: string[]): string {
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} et al.` : names.join(', ');
}

/**
 * The headline (`lib/headline.ts`: for a paper, accepted in any form), with
 * the outcome bar under it when there are more than two outcomes. Settled: the
 * winner. Void: nothing.
 */
function headline(r: BrowseRow): React.ReactNode {
  if (r.market.status === 'settled') {
    return r.outcomes.find((o) => o.id === r.market.resolvedOutcomeId)?.label ?? 'settled';
  }
  const h = marketHeadline({ ...r.market, outcomes: r.outcomes });
  if (h === null) return '—';
  const n = r.outcomes.length;
  return (
    <span className="inline-flex flex-col items-end gap-1">
      {pct(h)}
      {n > 2 && <OutcomeBar prices={r.outcomes.map((o) => o.price)} labels={r.outcomes.map((o) => o.label)} className="h-1 w-14" />}
    </span>
  );
}
