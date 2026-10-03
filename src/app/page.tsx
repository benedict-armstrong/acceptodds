import type { Metadata } from 'next';
import Link from 'next/link';
import { cookies, headers } from 'next/headers';
import { Collapsible } from '@/components/Collapsible';
import { MathText } from '@/components/MathText';
import { FilterIcon, MoreIcon } from '@/components/icons';
import { OutcomeBar } from '@/components/OutcomeBar';
import { Pager } from '@/components/Pager';
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/components/Popover';
import { Sparkline } from '@/components/Sparkline';
import { TitleBlock } from '@/components/TitleBlock';
import { ui } from '@/components/ui';
import { defaultMarketKind } from '@/lib/venue';
import { pct, rep, REP } from '@/lib/format';
import { marketHeadline } from '@/lib/headline';
import { REPO_URL } from '@/lib/links';
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

/** What the site is, above the search; hidden while searching. */
const ABSTRACT = (
  <>
    A prediction market on peer review. Each paper has a market on its decision (oral, spotlight, poster or reject),
    priced by researchers who stake $rep, an in app currency, on what they expect. Prices are probabilities, and every
    market settles when the venue publishes its decisions. It is a game made for fun, and has no connection to ICLR,
    OpenReview or any other organisation. acceptodds is an open source project, open to contributions, at{' '}
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

/** The home page's sorts, default first. The venue's `closing` is not offered. */
const SORTS = MARKET_SORTS.filter((s) => s !== 'closing');
/** Sort keys shown under another name. The venue's `likelihood` is the headline (`lib/headline.ts`). */
const SORT_LABEL: Partial<Record<BrowseSort, string>> = { likelihood: 'acceptance' };

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

/** The venue the list shows: `?kind=` if given (`all` is none), else the default venue if it has markets. */
function selectedKind(wanted: string | undefined, kinds: { kind: string }[]): string | null {
  if (wanted === 'all') return null;
  return wanted ?? (kinds.some((k) => k.kind === defaultMarketKind()) ? defaultMarketKind() : null);
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<Metadata> {
  const kind = selectedKind(one((await searchParams).kind), await marketKinds());
  return { title: `acceptodds: Which papers will get accepted${kind ? ` at ${kind}` : ''}?` };
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const kinds = await marketKinds();
  const wanted = one(sp.kind);
  const kind = selectedKind(wanted, kinds);
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
    pins ? pageOf(sp.fpage, FOLLOWING_PAGE, { ...browse, followedBy: me, exceptHeldBy: me }) : null,
    pins ? pageOf(sp.hpage, POSITIONS_PAGE, { ...browse, heldBy: me }) : null,
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
  // With one venue, "all venues" is the same list again.
  const allVenues = kinds.length > 1;

  return (
    <main className={ui.page}>
      <TitleBlock
        title={
          <>
            accept<i className="text-accent not-italic">odds</i>: Which papers will get accepted
            {kind ? ` at ${kind}` : ''}?
          </>
        }
        abstract={q ? null : ABSTRACT}
        abstractFull
      />
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
          className="min-w-0 flex-1 border border-rule bg-card px-2 py-1.5 font-sans text-sm leading-[normal] placeholder:text-faint narrow:text-base focus:border-frame focus:outline-none"
        />
        <button
          type="submit"
          className="cursor-pointer border border-rule bg-rule-soft px-3.5 font-sans text-sm font-semibold text-ink"
        >
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
              <h3 className={ui.boxHeading}>Venue</h3>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {kinds.map((k) => (
                  <PopoverClose key={k.kind} asChild>
                    <Link href={href({ kind: k.kind })} className={k.kind === kind ? ON : ''}>
                      {k.kind}
                    </Link>
                  </PopoverClose>
                ))}
                {allVenues && (
                  <PopoverClose asChild>
                    <Link href={href({ kind: 'all' })} className={kind === null ? ON : ''}>
                      all venues
                    </Link>
                  </PopoverClose>
                )}
              </div>
            </div>
            <div>
              <h3 className={ui.boxHeading}>Sort</h3>
              <div className="flex flex-wrap gap-x-4 gap-y-2">
                {sorts.map((s) => (
                  <PopoverClose key={s} asChild>
                    <Link href={href({ sort: s })} className={s === sort ? ON : ''}>
                      {SORT_LABEL[s] ?? s}
                    </Link>
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
                <SearchSyntax />
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
        <span className="flex flex-wrap gap-x-3 gap-y-1">
          {kinds.map((k) => (
            <Link key={k.kind} href={href({ kind: k.kind })} className={k.kind === kind ? ON : ''}>
              {k.kind}
            </Link>
          ))}
          {allVenues && (
            <Link href={href({ kind: 'all' })} className={kind === null ? ON : ''}>
              all venues
            </Link>
          )}
        </span>
        <span className="flex-1" />
        <span className="flex flex-wrap gap-x-3 gap-y-1">
          sort:
          {sorts.map((s) => (
            <Link key={s} href={href({ sort: s })} className={s === sort ? ON : ''}>
              {SORT_LABEL[s] ?? s}
            </Link>
          ))}
        </span>
        {/* Status and following, out of the way. */}
        <Popover>
          {/* Not a flex box: an icon alone gives a flex item no text baseline, and the row aligns on
              baselines. Inline, `align-middle` centres the dots on the text's x-height. */}
          <PopoverTrigger
            title="More filters: status, following, TLDRs"
            className="-my-1 cursor-pointer px-1 py-1 text-ink hover:text-accent"
          >
            {activeFilters}
            <MoreIcon className={`inline-block size-5 align-middle ${activeFilters ? 'ml-1' : ''}`} />
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
          className="group mt-3.5"
          summary={
            <>
              Following <span className="font-normal">({followed.total})</span>
            </>
          }
        >
          {followed.rows.map((r) => (
            <Row key={r.market.id} r={r} spark={sparks.get(r.market.id) ?? []} tldr={showTldr} />
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
            <>
              My positions <span className="font-normal">({held.total})</span>
            </>
          }
        >
          {held.rows.map((r) => (
            <Row key={r.market.id} r={r} spark={sparks.get(r.market.id) ?? []} tldr={showTldr} />
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
            <Row key={r.market.id} r={r} spark={sparks.get(r.market.id) ?? []} tldr={showTldr} />
          ))}
          <Pager page={all.page} pages={all.pages} href={pageHref('page', pinnedCount > 0 ? '#all' : '')} />
        </section>
      )}

      {!q && FOOTNOTE}
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
        <SearchSyntax />
      </PopoverContent>
    </Popover>
  );
}

/** The search syntax, for the desktop `?` and the phone's filter menu. */
function SearchSyntax() {
  return (
    <>
      <p>
        Words search titles, authors and abstracts; the last one may be half-typed. <code>&quot;a phrase&quot;</code>{' '}
        matches in order, <code>-word</code> excludes. Words alone also find people. Terms are ANDed; use{' '}
        <code>OR</code> and <code>( )</code> to group, and <code>-</code> before a filter or group to negate it.
      </p>
      <table className={ui.table}>
        <thead>
          <tr>
            <th className={ui.th()}>Filter</th>
            <th className={ui.th()}>Means</th>
            <th className={`${ui.th()} narrow:hidden`}>Also</th>
          </tr>
        </thead>
        <tbody>
          {FIELD_HELP.map((f) => (
            <tr key={f.field}>
              <td className={`${ui.td} font-mono text-ink`}>{f.example}</td>
              <td className={ui.td}>{f.means}</td>
              <td className={`${ui.td} text-faint narrow:hidden`}>{f.aliases.map((a) => `${a}:`).join(' ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1.5">
        Numbers take <code>: = != &gt; &lt; &gt;= &lt;=</code>; text filters take <code>:</code> and <code>!=</code>.
        Quote a value with spaces. For example:{' '}
        <code>(venue:iclr OR venue:neurips) diffusion accept&gt;=60 -status:settled</code>
      </p>
    </>
  );
}

/**
 * One paper (or unlisted market) in a list. The whole row opens it: the
 * title's link is stretched over the row (`after:inset-0`), since a row that
 * is itself a link could not hold the paper's own PDF link, which sits above
 * the stretched one, in a column of its own at the left so titles align.
 */
function Row({ r, spark, tldr }: { r: BrowseRow; spark: number[]; tldr: boolean }) {
  const look = likelihoodClass(marketLikelihood({ ...r.market, outcomes: r.outcomes }));
  const pdf = r.listing?.links.find((l) => l.label.toLowerCase() === 'pdf');
  const names = r.listing && r.listing.authors.length > 0 ? authors(r.listing.authors) : null;
  return (
    <div className="relative grid grid-cols-[3px_34px_1fr_90px_90px_110px] items-center gap-x-3.5 border-b border-dotted border-rule-strong py-2 hover:bg-highlight narrow:grid-cols-[3px_34px_1fr_64px]">
      <span className={`self-stretch ${look.bar}`} aria-hidden />
      <span className="font-sans text-xs">
        {pdf && (
          <a href={pdf.url} className="relative z-10 text-accent" rel="noopener noreferrer" target="_blank">
            [{pdf.label}]
          </a>
        )}
      </span>
      <span className="min-w-0 leading-[1.35]">
        {/* At most two lines; the whole title on hover. */}
        <Link
          href={r.listing ? `/papers/${r.listing.slug}` : `/markets/${r.market.slug}`}
          className="line-clamp-2 after:absolute after:inset-0 hover:no-underline"
          title={r.listing ? r.listing.title : r.market.question}
        >
          <MathText text={r.listing ? r.listing.title : r.market.question} />
        </Link>
        {names && <span className="block font-sans text-xs text-muted">{names}</span>}
        {tldr && r.listing?.tldr && (
          <span className="mt-0.5 block text-[13px] leading-snug text-muted">
            <MathText text={r.listing.tldr} />
          </span>
        )}
      </span>
      <span className="text-right font-mono text-xs text-muted narrow:hidden" title="volume">
        {r.totalOrderCount > 0 ? `${rep(r.totalVolumeMicro, 0)} ${REP}` : ''}
      </span>
      <span className="narrow:hidden" title={r.listing ? r.market.question : undefined}>
        <Sparkline values={spark} />
      </span>
      <span
        className={`text-right font-mono text-sm ${look.text}`}
        title={r.listing ? `${r.market.question}: chance of acceptance` : undefined}
      >
        {headline(r)}
      </span>
    </div>
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
      {n > 2 && (
        <OutcomeBar
          prices={r.outcomes.map((o) => o.price)}
          labels={r.outcomes.map((o) => o.label)}
          className="h-1 w-14"
        />
      )}
    </span>
  );
}
