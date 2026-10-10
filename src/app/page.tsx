import type { Metadata } from 'next';
import type { ComponentProps } from 'react';
import Link from 'next/link';
import { cookies, headers } from 'next/headers';
import { Collapsible } from '@/components/Collapsible';
import { FilterIcon, MoreIcon } from '@/components/icons';
import { Pager } from '@/components/Pager';
import { SearchSyntax } from '@/components/SearchSyntax';
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/components/Popover';
import { PaperRow } from '@/components/PaperRow';
import { ScrollingLink } from '@/components/ScrollLink';
import { RememberVenue, VenueInUrl } from '@/components/RememberVenue';
import { RememberHomeSearch } from '@/components/HomeLink';
import { TitleBlock } from '@/components/TitleBlock';
import { OnboardAgent } from '@/components/OnboardAgent';
import { InstitutionStrip } from '@/components/InstitutionStrip';
import { TutorialModal } from '@/components/TutorialModal';
import { Wordmark } from '@/components/Wordmark';
import type { z } from 'zod';
import type * as S from '@/server/api/schemas';
import { presentListing } from '@/server/api/present';
import { ui } from '@/components/ui';
import { pricedBeforeTrade, venue, venues, type Venue } from '@/venues';
import { rep, REP } from '@/lib/format';
import { REPO_URL } from '@/lib/links';
import { parseSearch, peopleText } from '@/lib/query';
import { normalizeSearch, SEARCH_MAX_LENGTH } from '@/lib/search';
import { viewerFromHeaders } from '@/server/auth';
import { currentVenue } from '@/server/current-venue';
import { siteName, venuePreviewImages } from '@/server/share';
import { startingBalanceMicro } from '@/server/accounts';
import * as events from '@/server/events';
import {
  browseListings,
  hasTraded,
  listingViews,
  MARKET_SORTS,
  marketKinds,
  searchPeople,
  sparklines,
  traderInstitutions,
  type BrowsePage,
  type BrowseRow,
  type BrowseSort,
} from '@/server/views';
import { canRecommend } from '@/server/recommendations';

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

/** "A, B or C": the organisations the abstract disclaims, then "any other". */
function orList(items: readonly string[]): string {
  return items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

/**
 * What the site is, above the search, in the selected venue's words
 * (`venues/`): its own `abstract` when it has one, else one built from its
 * pieces; with no venue, words that fit them all. Hidden while searching.
 */
const abstract = (v: Venue | null) => {
  const balance = `${rep(startingBalanceMicro(), 0)} ${REP}`;
  return (
    <>
      {v?.abstract ? (
        v.abstract.replaceAll('{balance}', balance)
      ) : (
        <>
          {v?.lede ?? 'A prediction market on research papers'}. Each paper has a market on{' '}
          {v?.marketOn ?? 'what becomes of it'}, priced by researchers who stake $rep, an in app currency, on what they
          expect. Everyone who signs up receives {balance} to trade with in each venue. Prices are probabilities, and
          every market settles when {v?.settlesWhen ?? 'its outcome is known'}. It is a game made for fun, and has no
          connection to{' '}
          {orList([...new Set((v ? [v] : venues()).flatMap((x) => x.unaffiliated)), 'any other organisation'])}.
        </>
      )}{' '}
      acceptodds is an open source project, open to contributions, at{' '}
      <a href={REPO_URL} className={ui.hyperref}>
        {REPO_URL.replace(/^https:\/\//, '')}
      </a>
      .
      <sup>
        <a href="#footnote-1" id="footnote-1-ref" className="text-accent">
          1
        </a>
      </sup>
    </>
  );
};

/** The abstract's footnote, set at the foot of the page as a paper's is. */
const FOOTNOTE = (
  <div id="footnote-1" className="mt-10 text-sm leading-normal text-subtle">
    <hr className="mb-2 w-1/3 border-rule" />
    <sup className="text-accent">1</sup> If this project is interesting to you, reach out at{' '}
    <a href="mailto:hello@acceptodds.com" className={ui.hyperref}>
      hello@acceptodds.com
    </a>
    .
  </div>
);

/** The home page's sorts, default first: activity. The venue's `closing` is not offered. */
const SORTS: readonly BrowseSort[] = ['activity', ...MARKET_SORTS.filter((s) => s !== 'closing' && s !== 'activity')];
/** Sorts kept out of the row, in the ⋯ menu (on a phone every sort is in the filter menu). */
const MENU_SORTS: readonly BrowseSort[] = ['volume', 'newest'];
/** Sort keys shown under another name: `likelihood` is the headline (`lib/headline.ts`). */
const sortLabel = (s: BrowseSort) => (s === 'likelihood' ? 'odds' : s);

/** The page's title after the wordmark: the venue's question, or one that fits any venue. */
function homeTitle(kind: string | null): string {
  return venue(kind)?.homeTitle ?? `Which papers will make it${kind ? ` at ${kind}` : ''}?`;
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

/**
 * The venue the list shows: `?kind=` if given (`all` is none: a search of
 * every venue), else the navbar's (`currentVenue()`) if it has papers.
 */
function selectedKind(wanted: string | undefined, kinds: { kind: string }[], navVenue: string): string | null {
  if (wanted === 'all') return null;
  return wanted ?? (kinds.some((k) => k.kind === navVenue) ? navVenue : null);
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<Metadata> {
  const kind = selectedKind(one((await searchParams).kind), await marketKinds(), await currentVenue());
  const title = `acceptodds: ${homeTitle(kind)}`;
  const description = 'A prediction market on the fate of research papers, traded in reputation.';
  // A shared home link names its venue (`VenueInUrl`), and its preview is that venue's card.
  const images = venuePreviewImages(kind);
  return {
    title,
    openGraph: {
      title,
      description,
      url: kind ? `/?${new URLSearchParams({ kind })}` : '/',
      type: 'website',
      siteName: siteName(),
      images,
    },
    twitter: { card: 'summary_large_image', title, description, images },
  };
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const kinds = await marketKinds();
  const wanted = one(sp.kind);
  // The venue the navbar was drawn in: the list's, unless the URL names another.
  const navVenue = await currentVenue();
  const kind = selectedKind(wanted, kinds, navVenue);
  const status: Status = (STATUSES as readonly string[]).includes(one(sp.status) ?? '')
    ? (one(sp.status) as Status)
    : 'open';
  // A search keeps the venue and status filters (the form carries them) and
  // sorts by relevance unless another sort is asked for.
  const q = normalizeSearch(one(sp.q));
  // The search syntax (`lib/query.ts`). A `venue:` or `status:` in the query
  // says where to look, so the page's own filter of that kind steps aside.
  const parsed = q ? parseSearch(q) : null;
  const kindFilter = parsed?.fields.has('venue') ? null : kind;
  const statusFilter: Status = parsed?.fields.has('status') ? 'all' : status;
  const viewer = await viewerFromHeaders(await headers());
  const me = viewer?.account.id ?? null;
  // `recommended` once the viewer has done enough for it to mean something (`server/recommendations.ts`).
  const recommends = me !== null && (await canRecommend(me));
  // It is then the default, listed first.
  const offered: readonly BrowseSort[] = recommends ? ['recommended', ...SORTS] : SORTS;
  const sorts: readonly BrowseSort[] = q ? ['relevance', ...offered] : offered;
  const sort: BrowseSort = (sorts as readonly string[]).includes(one(sp.sort) ?? '')
    ? (one(sp.sort) as BrowseSort)
    : q
      ? 'relevance'
      : offered[0];

  // One row per listing (a paper), read from its main market; plus one per
  // market that belongs to no listing. Each section is paged in the database.
  // ?following=1: only papers the signed-in viewer follows.
  const onlyFollowed = viewer !== null && one(sp.following) === '1';
  // ?tldr=1: each paper's TLDR under its authors.
  const showTldr = one(sp.tldr) === '1';
  // Papers the viewer follows, then papers they hold shares in, are pinned
  // above the list: same venue, status and sort, each paged on its own, and
  // none repeated. A paper both followed and held is under My positions. Not while searching, nor when the list is already
  // only followed papers.
  const pins = me !== null && !q && !onlyFollowed;
  const browse = { kind, status, sort };
  // A search that is only words may be a name: traders above the papers, on
  // the first page.
  const who = peopleText(parsed?.node ?? null);
  const [all, followed, held, people, busiest, traded, institutions] = await Promise.all([
    pageOf(sp.page, PAGE, {
      ...browse,
      kind: kindFilter,
      status: statusFilter,
      q,
      followedBy: onlyFollowed ? me : null,
      exceptFollowedBy: pins ? me : null,
      exceptHeldBy: pins ? me : null,
      recommendFor: me,
    }),
    pins ? pageOf(sp.fpage, FOLLOWING_PAGE, { ...browse, followedBy: me, exceptHeldBy: me }) : null,
    pins ? pageOf(sp.hpage, POSITIONS_PAGE, { ...browse, heldBy: me }) : null,
    who && (one(sp.page) ?? '1') === '1' ? searchPeople(who, PEOPLE) : [],
    // The tutorial shows one real market's odds: the venue's most traded open paper.
    browseListings({ kind: kind ?? navVenue, status: 'open', sort: 'volume', traded: true, limit: 1 }),
    // A trader who has placed an order is past getting started: no tutorial.
    me !== null ? hasTraded(me) : false,
    // Signed out, and not searching: where the traders are from.
    viewer === null && !q ? traderInstitutions() : [],
  ]);
  const busiestListing = busiest.rows[0]?.listing;
  const [tutorialExample] = busiestListing
    ? ((await listingViews([busiestListing])).map(presentListing) as z.output<typeof S.Listing>[])
    : [];
  const cookieJar = await cookies();
  const followingOpen = cookieJar.get(FOLLOWING_COOKIE)?.value !== '0';
  const positionsOpen = cookieJar.get(POSITIONS_COOKIE)?.value !== '0';
  const sparks = await sparklines(
    [...all.rows, ...(followed?.rows ?? []), ...(held?.rows ?? [])].flatMap((r) => (r.main ? [r.main] : [])),
  );
  events.log('market.list', { accountId: me });

  // Filter links keep the search; `q: ''` drops it (and its relevance sort).
  // They go back to page 1: pages are kept only by the pagers' own links.
  // Every link names the venue, so a copied URL opens the same list for anyone,
  // whatever venue their own browser last picked.
  const href = (patch: Record<string, string>) => {
    const params = new URLSearchParams({
      kind: kind ?? 'all',
      status,
      sort,
      ...(q ? { q } : {}),
      ...(onlyFollowed ? { following: '1' } : {}),
      ...(showTldr ? { tldr: '1' } : {}),
      ...patch,
    });
    if (!params.get('q')) {
      params.delete('q');
      if (params.get('sort') === 'relevance') params.delete('sort');
    }
    if (params.get('following') === '0') params.delete('following');
    if (params.get('tldr') === '0') params.delete('tldr');
    for (const key of ['page', 'fpage', 'hpage']) if (params.get(key) === '1') params.delete(key);
    return `/?${params}`;
  };
  // A pager's link to page `p` of its section, keeping the other sections' pages.
  const pages = { page: String(all.page), fpage: String(followed?.page ?? 1), hpage: String(held?.page ?? 1) };
  const pageHref = (key: keyof typeof pages, anchor: string) => (p: number) =>
    `${href({ ...pages, [key]: String(p) })}${anchor}`;
  const filtered = kindFilter !== null || statusFilter !== 'all';
  const pinnedCount = (followed?.total ?? 0) + (held?.total ?? 0);
  // Shown on the ⋯ trigger when not the defaults.
  const activeFilters = [status !== 'open' && status, onlyFollowed && '★', showTldr && 'tldr']
    .filter(Boolean)
    .join(', ');
  // The ⋯ trigger also names a sort picked from its menu, since the row doesn't show it.
  const menuSort = MENU_SORTS.includes(sort) ? sortLabel(sort) : null;
  const moreLabel = [menuSort, activeFilters].filter(Boolean).join(', ');

  return (
    <main className={ui.page}>
      {/* A venue named in the URL (a link from elsewhere) becomes the navbar's, and the one `/welcome` searches first. */}
      {wanted && kinds.some((k) => k.kind === wanted) && <RememberVenue kind={wanted} stale={wanted !== navVenue} />}
      {/* A venue taken from the cookie is written into the address bar, so sharing it shares the venue. */}
      {wanted === undefined && <VenueInUrl kind={kind ?? 'all'} />}
      {/* The logo, from any other page, comes back to this list as it is now. */}
      <RememberHomeSearch />
      <TitleBlock
        title={
          <>
            <Wordmark />: {homeTitle(kind)}
          </>
        }
        abstract={q ? null : abstract(venue(kind))}
        abstractFull
      >
        <div className="flex flex-wrap items-baseline justify-center gap-x-6">
          {!traded && (
            <TutorialModal
              example={tutorialExample}
              startingBalanceMicro={startingBalanceMicro().toString()}
              signedIn={viewer !== null}
            />
          )}
          {viewer && (
            <div className="max-w-sm">
              <OnboardAgent signedIn className={`font-sans text-[13px] ${ui.linkBtn}`} />
            </div>
          )}
        </div>
      </TitleBlock>
      <InstitutionStrip institutions={institutions} />
      {/* A plain GET form, so search works without JavaScript. */}
      <form action="/" method="get" role="search" className="mt-5 flex gap-2">
        <input type="hidden" name="kind" value={kind ?? 'all'} />
        <input type="hidden" name="status" value={status} />
        {onlyFollowed && <input type="hidden" name="following" value="1" />}
        {showTldr && <input type="hidden" name="tldr" value="1" />}
        <input
          type="search"
          name="q"
          defaultValue={q ?? ''}
          maxLength={SEARCH_MAX_LENGTH}
          aria-label="Search papers and people"
          placeholder="Search papers and people"
          className={ui.searchInput}
        />
        <button type="submit" className={ui.searchBtn}>
          Search
        </button>
        <SearchHelp />
        {/* On a phone the filters fold into this one menu, with the search syntax. */}
        <Popover>
          <PopoverTrigger
            type="button"
            title="Filters and search syntax"
            aria-label="Filters and search syntax"
            className="relative hidden cursor-pointer px-2.5 text-muted hover:text-accent narrow:flex narrow:items-center"
          >
            <FilterIcon className="size-5" />
            {activeFilters && <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-accent" />}
          </PopoverTrigger>
          <PopoverContent align="end" className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto text-[13px]">
            <div>
              <h3 className={ui.boxHeading}>Sort</h3>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {sorts.map((s) => (
                  <PopoverClose key={s} asChild>
                    <SortLink pinned={pinnedCount > 0} href={href({ sort: s })} className={s === sort ? ON : ''}>
                      {sortLabel(s)}
                    </SortLink>
                  </PopoverClose>
                ))}
              </div>
            </div>
            <div>
              <h3 className={ui.boxHeading}>Status</h3>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {STATUSES.map((s) => (
                  <PopoverClose key={s} asChild>
                    <Link href={href({ status: s })} className={s === status ? ON : ''}>
                      {s}
                    </Link>
                  </PopoverClose>
                ))}
              </div>
            </div>
            {viewer && (
              <PopoverClose asChild>
                <Link href={href({ following: onlyFollowed ? '0' : '1' })} className={onlyFollowed ? ON : ''}>
                  ★ following only
                </Link>
              </PopoverClose>
            )}
            <PopoverClose asChild>
              <Link href={href({ tldr: showTldr ? '0' : '1' })} className={showTldr ? ON : ''}>
                show TLDRs
              </Link>
            </PopoverClose>
            <details className="border-t border-rule pt-2.5">
              <summary className={`${ui.runIn} cursor-pointer`}>Search syntax</summary>
              <div className="mt-2 text-xs leading-normal text-muted">
                <SearchSyntax people />
              </div>
            </details>
          </PopoverContent>
        </Popover>
      </form>

      {parsed && parsed.errors.length > 0 && (
        <div className="mt-2 font-sans text-[13px] text-down">Ignored: {parsed.errors.join('; ')}</div>
      )}

      {q && (
        <div className="mt-2 font-sans text-[13px] text-muted">
          {all.total.toLocaleString('en')} {all.total === 1 ? 'result' : 'results'} for “{q}”
          {filtered && (
            <>
              {' '}
              in {kindFilter ?? 'all venues'}
              {statusFilter !== 'all' && `, ${statusFilter}`}.{' '}
              <Link href={href({ kind: 'all', status: 'all' })}>search everything</Link>
            </>
          )}{' '}
          <Link href={href({ q: '' })}>clear</Link>
        </div>
      )}

      {people.length > 0 && (
        <section aria-label="People">
          <h2 className={ui.groupHeading}>People</h2>
          {people.map((p) => (
            <Link
              key={p.accountId}
              href={`/people/${encodeURIComponent(p.handle)}`}
              className="flex items-baseline gap-2 border-b border-dotted border-rule-strong py-1.5 hover:bg-highlight hover:no-underline"
            >
              <span>{p.displayName}</span>
              <span className="font-mono text-xs text-muted">@{p.handle}</span>
              {p.isBot && <span className={ui.badge}>bot</span>}
              <span className="flex-1" />
              <span className="font-sans text-xs text-muted">{p.institutions.join('; ')}</span>
            </Link>
          ))}
        </section>
      )}

      <div className="mt-2 mb-1 flex flex-wrap items-baseline gap-x-4.5 gap-y-1.5 font-sans text-[13px] text-muted narrow:hidden">
        <span className="flex-1" />
        <span className="flex flex-wrap gap-x-3 gap-y-1">
          sort:
          {sorts
            .filter((s) => !MENU_SORTS.includes(s))
            .map((s) => (
              <SortLink key={s} pinned={pinnedCount > 0} href={href({ sort: s })} className={s === sort ? ON : ''}>
                {sortLabel(s)}
              </SortLink>
            ))}
        </span>
        {/* The rarer sorts, status and following, out of the way. */}
        <Popover>
          {/* Not a flex box: an icon alone gives a flex item no text baseline, and the row aligns on
              baselines. Inline, `align-middle` centres the dots on the text's x-height. */}
          <PopoverTrigger
            title="More sorts and filters: status, following, TLDRs"
            className="-my-1 cursor-pointer px-1 py-1 text-ink hover:text-accent"
          >
            {moreLabel}
            <MoreIcon className={`inline-block size-5 align-middle ${moreLabel ? 'ml-1' : ''}`} />
          </PopoverTrigger>
          <PopoverContent menu align="end" className="text-[13px]">
            {MENU_SORTS.map((s) => (
              <PopoverClose key={s} asChild>
                <SortLink pinned={pinnedCount > 0} href={href({ sort: s })} className={s === sort ? ON : ''}>
                  sort: {sortLabel(s)}
                </SortLink>
              </PopoverClose>
            ))}
            {STATUSES.map((s, i) => (
              <PopoverClose key={s} asChild>
                <Link
                  href={href({ status: s })}
                  className={`${i === 0 ? 'mt-1 border-t border-rule pt-1.5 ' : ''}${s === status ? ON : ''}`}
                >
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
            <PopoverClose asChild>
              <Link
                href={href({ tldr: showTldr ? '0' : '1' })}
                className={`${viewer ? '' : 'mt-1 border-t border-rule pt-1.5 '}${showTldr ? ON : ''}`}
              >
                show TLDRs
              </Link>
            </PopoverClose>
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
          className="group"
          summary={
            <>
              Following <span className="font-normal">({followed.total})</span>
            </>
          }
        >
          {followed.rows.map((r) => (
            <Row key={rowKey(r)} r={r} spark={(r.main && sparks.get(r.main.market.id)) || []} tldr={showTldr} />
          ))}
          <Pager page={followed.page} pages={followed.pages} href={pageHref('fpage', '#following')} />
        </Collapsible>
      )}

      {held && held.total > 0 && (
        <Collapsible
          id="positions"
          cookie={POSITIONS_COOKIE}
          open={positionsOpen}
          className="group"
          summary={
            <>
              My positions <span className="font-normal">({held.total})</span>
            </>
          }
        >
          {held.rows.map((r) => (
            <Row key={rowKey(r)} r={r} spark={(r.main && sparks.get(r.main.market.id)) || []} tldr={showTldr} />
          ))}
          <Pager page={held.page} pages={held.pages} href={pageHref('hpage', '#positions')} />
        </Collapsible>
      )}

      {all.total > 0 && (
        <section id="all">
          {pinnedCount > 0 ? (
            <h2 className={`mt-7 mb-2 ${ui.section}`}>
              All papers <span className="font-normal">({all.total.toLocaleString('en')})</span>
            </h2>
          ) : (
            <div className="h-3.5" />
          )}
          {all.rows.map((r) => (
            <Row key={rowKey(r)} r={r} spark={(r.main && sparks.get(r.main.market.id)) || []} tldr={showTldr} />
          ))}
          <Pager page={all.page} pages={all.pages} href={pageHref('page', pinnedCount > 0 ? '#all' : '')} />
        </section>
      )}

      {!q && FOOTNOTE}
      <p className="mt-6 font-sans text-xs text-muted">
        <Link href="/privacy" className="text-muted">
          Privacy
        </Link>
      </p>
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
        className="cursor-pointer px-1 font-sans text-sm text-muted hover:text-accent narrow:hidden"
      >
        ?
      </PopoverTrigger>
      <PopoverContent align="end" className="text-xs leading-normal text-muted">
        <SearchSyntax people />
      </PopoverContent>
    </Popover>
  );
}

/**
 * One paper (or unlisted market) in a list. The whole row opens it: the
 * title's link is stretched over the row (`after:inset-0`), since a row that
 * is itself a link could not hold the paper's own PDF link, which sits above
 * the stretched one, in a column of its own at the left so titles align.
 */
function Row({ r, spark, tldr }: { r: BrowseRow; spark: number[]; tldr: boolean }) {
  const pdf = r.listing?.links.find((l) => l.label.toLowerCase() === 'pdf');
  return (
    <PaperRow
      title={r.listing?.title ?? r.main?.market.question ?? ''}
      authors={r.listing?.authors ?? []}
      pdf={pdf}
      tldr={tldr ? r.listing?.tldr : null}
      // No price on the list until someone trades, where an untraded market's is only JEV's (`pricedBeforeTrade`).
      market={
        r.main && (r.main.orderCount > 0 || pricedBeforeTrade(r.main.market.kind))
          ? { ...r.main.market, outcomes: r.main.outcomes }
          : null
      }
      volumeMicro={r.totalOrderCount > 0 ? r.totalVolumeMicro : null}
      spark={spark}
      href={r.listing ? `/papers/${r.listing.slug}` : `/markets/${r.main?.market.slug}`}
    />
  );
}

/** A row's key: its listing, or its standalone market. */
function rowKey(r: BrowseRow): string {
  return r.listing?.id ?? r.main?.market.id ?? '';
}

/**
 * A sort's link. A sort reorders the list, not the sections pinned above it,
 * so with any shown it scrolls slowly to "All papers", a quarter down the
 * window, and the re-sorted page keeps that place.
 */
function SortLink({ pinned, ...props }: ComponentProps<typeof Link> & { pinned: boolean }) {
  return pinned ? <ScrollingLink to="all" at={0.25} {...props} /> : <Link {...props} />;
}
