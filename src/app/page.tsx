import Link from 'next/link';
import { cookies, headers } from 'next/headers';
import { Collapsible } from '@/components/Collapsible';
import { MathText } from '@/components/MathText';
import { OutcomeBar } from '@/components/OutcomeBar';
import { Pager } from '@/components/Pager';
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/components/Popover';
import { Sparkline } from '@/components/Sparkline';
import { ui } from '@/components/ui';
import { pct, rep, REP } from '@/lib/format';
import { marketHeadline } from '@/lib/headline';
import { likelihoodClass, marketLikelihood } from '@/lib/likelihood';
import { FIELD_HELP, parseSearch, peopleText } from '@/lib/query';
import { normalizeSearch, SEARCH_MAX_LENGTH } from '@/lib/search';
import { viewerFromHeaders } from '@/server/auth';
import * as events from '@/server/events';
import {
  browseListings,
  MARKET_SORTS,
  marketKinds,
  searchPeople,
  sparklines,
  type BrowsePage,
  type BrowseRow,
  type BrowseSort,
} from '@/server/views';

export const dynamic = 'force-dynamic';

/** The selected filter link. */
const ON = ui.on;

const STATUSES = ['open', 'closed', 'settled', 'all'] as const;
type Status = (typeof STATUSES)[number];

/** Papers per page in the main list; `?page=` pages it. */
const PAGE = 50;
/** Followed papers per page in the "Following" section; `?fpage=` pages it. */
const FOLLOWING_PAGE = 10;
/** The cookie remembering whether that section was left collapsed. */
const FOLLOWING_COOKIE = 'home_following_open';
/** Same for the "My positions" section. */
const POSITIONS_PAGE = 10;
const POSITIONS_COOKIE = 'home_positions_open';
/** Traders shown above the papers when a search reads like a name. */
const PEOPLE = 5;

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

/**
 * Page `requested` (1-based) of a list, `size` rows a page. Past the end it
 * serves the last page, so a stale link after the list shrank still shows
 * something.
 */
async function pageOf(
  requested: string | string[] | undefined,
  size: number,
  query: Omit<Parameters<typeof browseListings>[0], 'offset' | 'limit'>,
): Promise<BrowsePage & { page: number; pages: number }> {
  const page = Math.max(1, Number.parseInt(one(requested) ?? '1', 10) || 1);
  let result = await browseListings({ ...query, offset: (page - 1) * size, limit: size });
  const pages = Math.max(1, Math.ceil(result.total / size));
  if (page <= pages) return { ...result, page, pages };
  result = await browseListings({ ...query, offset: (pages - 1) * size, limit: size });
  return { ...result, page: pages, pages };
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
  // The search syntax (`lib/query.ts`). A `venue:` or `status:` in the query
  // says where to look, so the page's own filter of that kind steps aside.
  const parsed = q ? parseSearch(q) : null;
  const kindFilter = parsed?.fields.has('venue') ? null : kind;
  const statusFilter: Status = parsed?.fields.has('status') ? 'all' : status;
  const sorts: readonly BrowseSort[] = q ? ['relevance', ...SORTS] : SORTS;
  const sort: BrowseSort = (sorts as readonly string[]).includes(one(sp.sort) ?? '')
    ? (one(sp.sort) as BrowseSort)
    : q
      ? 'relevance'
      : SORTS[0];

  // One row per listing (a paper), read from its main market; plus one per
  // market that belongs to no listing. Each section is paged in the database.
  const viewer = await viewerFromHeaders(await headers());
  // ?following=1: only papers the signed-in viewer follows.
  const onlyFollowed = viewer !== null && one(sp.following) === '1';
  const me = viewer?.account.id ?? null;
  // Papers the viewer follows, then papers they hold shares in, are pinned
  // above the list: same venue, status and sort, each paged on its own, and
  // none repeated below. Not while searching, nor when the list is already
  // only followed papers.
  const pins = me !== null && !q && !onlyFollowed;
  const browse = { kind, status, sort };
  // A search that is only words may be a name: traders above the papers, on
  // the first page.
  const who = peopleText(parsed?.node ?? null);
  const [all, followed, held, people] = await Promise.all([
    pageOf(sp.page, PAGE, {
      ...browse,
      kind: kindFilter,
      status: statusFilter,
      q,
      followedBy: onlyFollowed ? me : null,
      exceptFollowedBy: pins ? me : null,
      exceptHeldBy: pins ? me : null,
    }),
    pins ? pageOf(sp.fpage, FOLLOWING_PAGE, { ...browse, followedBy: me }) : null,
    pins ? pageOf(sp.hpage, POSITIONS_PAGE, { ...browse, heldBy: me, exceptFollowedBy: me }) : null,
    who && (one(sp.page) ?? '1') === '1' ? searchPeople(who, PEOPLE) : [],
  ]);
  const cookieJar = await cookies();
  const followingOpen = cookieJar.get(FOLLOWING_COOKIE)?.value !== '0';
  const positionsOpen = cookieJar.get(POSITIONS_COOKIE)?.value !== '0';
  const sparks = await sparklines([...all.rows, ...(followed?.rows ?? []), ...(held?.rows ?? [])]);
  events.log('market.list', { accountId: me });

  // Filter links keep the search; `q: ''` drops it (and its relevance sort).
  // They go back to page 1: pages are kept only by the pagers' own links.
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
    for (const key of ['page', 'fpage', 'hpage']) if (params.get(key) === '1') params.delete(key);
    return `/?${params}`;
  };
  // A pager's link to page `p` of its section, keeping the other sections' pages.
  const pages = { page: String(all.page), fpage: String(followed?.page ?? 1), hpage: String(held?.page ?? 1) };
  const pageHref = (key: keyof typeof pages, anchor: string) => (p: number) =>
    `${href({ ...pages, [key]: String(p) })}${anchor}`;
  const filtered = kindFilter !== null || statusFilter !== 'all';
  const pinnedCount = (followed?.total ?? 0) + (held?.total ?? 0);

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
          aria-label="Search papers and people"
          placeholder='Search papers and people — "a phrase", -without, author:name, accept>=70'
          className="min-w-0 flex-1 border border-rule bg-card px-2 py-1.5 font-sans text-sm leading-[normal] placeholder:text-faint focus:border-frame focus:outline-none"
        />
        <button
          type="submit"
          className="cursor-pointer border border-rule bg-rule-soft px-3.5 font-sans text-sm font-semibold text-ink"
        >
          Search
        </button>
        <SearchHelp />
      </form>

      {parsed && parsed.errors.length > 0 && (
        <div className="mt-2 font-sans text-[13px] text-down">
          Ignored: {parsed.errors.join('; ')}
        </div>
      )}

      {q && (
        <div className="mt-2 font-sans text-[13px] text-muted">
          {all.total.toLocaleString('en')} {all.total === 1 ? 'result' : 'results'} for “{q}”
          {filtered && (
            <>
              {' '}
              in {kindFilter ?? 'all venues'}
              {statusFilter !== 'all' && `, ${statusFilter}`} ·{' '}
              <Link href={href({ kind: 'all', status: 'all' })}>search everything</Link>
            </>
          )}{' '}
          · <Link href={href({ q: '' })}>clear</Link>
        </div>
      )}

      {people.length > 0 && (
        <section aria-label="People">
          <h2 className={ui.groupHeading}>People</h2>
          {people.map((p) => (
            <Link
              key={p.accountId}
              href={`/leaderboard?around=${encodeURIComponent(p.handle)}#focus`}
              className="flex items-baseline gap-2 border-b border-dotted border-rule-strong py-1.5 hover:bg-highlight hover:no-underline"
            >
              <span>{p.displayName}</span>
              <span className="font-mono text-xs text-muted">@{p.handle}</span>
              {p.isBot && <span className={ui.badge}>bot</span>}
              <span className="flex-1" />
              <span className="font-sans text-xs text-muted">{p.institutionName ?? ''}</span>
            </Link>
          ))}
        </section>
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
        {/* Status and following, out of the way. */}
        <Popover>
          <PopoverTrigger title="More filters: status, following" className="cursor-pointer px-1 text-ink hover:text-accent">
            {[status !== 'open' && status, onlyFollowed && '★'].filter(Boolean).join(' · ')}
            {(status !== 'open' || onlyFollowed) && ' '}⋯
          </PopoverTrigger>
          <PopoverContent menu align="end" className="text-[13px]">
            {STATUSES.map((s) => (
              <PopoverClose key={s} asChild>
                <Link href={href({ status: s })} className={s === status ? ON : ''}>
                  {s}
                </Link>
              </PopoverClose>
            ))}
            {viewer && (
              <PopoverClose asChild>
                <Link
                  href={href({ following: onlyFollowed ? '0' : '1' })}
                  className={`mt-1 border-t border-rule pt-1.5 ${onlyFollowed ? ON : ''}`}
                >
                  ★ following
                </Link>
              </PopoverClose>
            )}
          </PopoverContent>
        </Popover>
      </div>

      {all.total + pinnedCount === 0 &&
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

      {followed && followed.total > 0 && (
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
              Following <span className="font-normal">({followed.total})</span>
            </summary>
          }
        >
          {followed.rows.map((r) => (
            <Row key={r.market.id} r={r} spark={sparks.get(r.market.id) ?? []} />
          ))}
          <Pager page={followed.page} pages={followed.pages} href={pageHref('fpage', '#following')} />
        </Collapsible>
      )}

      {held && held.total > 0 && (
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
              My positions <span className="font-normal">({held.total})</span>
            </summary>
          }
        >
          {held.rows.map((r) => (
            <Row key={r.market.id} r={r} spark={sparks.get(r.market.id) ?? []} />
          ))}
          <Pager page={held.page} pages={held.pages} href={pageHref('hpage', '#positions')} />
        </Collapsible>
      )}

      {all.total > 0 && (
        <section id="all">
          {pinnedCount > 0 ? (
            <h2 className={ui.groupHeading}>
              All papers <span className="font-normal">({all.total.toLocaleString('en')})</span>
            </h2>
          ) : (
            <div className="h-3.5" />
          )}
          {all.rows.map((r) => (
            <Row key={r.market.id} r={r} spark={sparks.get(r.market.id) ?? []} />
          ))}
          <Pager page={all.page} pages={all.pages} href={pageHref('page', pinnedCount > 0 ? '#all' : '')} />
        </section>
      )}
    </main>
  );
}

/** The search syntax (`lib/query.ts`), behind a `?` beside the Search button. */
function SearchHelp() {
  return (
    <Popover>
      <PopoverTrigger
        type="button"
        title="Search syntax"
        aria-label="Search syntax"
        className="cursor-pointer px-1 font-sans text-sm text-muted hover:text-accent"
      >
        ?
      </PopoverTrigger>
      <PopoverContent align="end" className="text-xs leading-normal text-muted">
        <p>
          Words search titles, authors and abstracts; the last one may be half-typed. <code>&quot;a phrase&quot;</code>{' '}
          matches in order, <code>-word</code> excludes. Words alone also find people. Terms are ANDed; use{' '}
          <code>OR</code> and <code>( )</code> to group, and <code>-</code> before a filter or group to negate it.
        </p>
        <table className="mt-1.5">
          <tbody>
            {FIELD_HELP.map((f) => (
              <tr key={f.field}>
                <td className="pr-3 font-mono text-ink">{f.example}</td>
                <td className="pr-3">{f.means}</td>
                <td className="text-faint">{f.aliases.map((a) => `${a}:`).join(' ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-1.5">
          Numbers take <code>: = != &gt; &lt; &gt;= &lt;=</code>; text filters take <code>:</code> and <code>!=</code>. Quote a
          value with spaces. For example: <code>(venue:iclr OR venue:neurips) diffusion accept&gt;=60 -status:settled</code>
        </p>
      </PopoverContent>
    </Popover>
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
        {r.totalOrderCount > 0 ? `${rep(r.totalVolumeMicro, 0)} ${REP}` : ''}
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
