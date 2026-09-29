import Link from 'next/link';
import { headers } from 'next/headers';
import { Sparkline } from '@/components/Sparkline';
import { ui } from '@/components/ui';
import { day, pct, rep } from '@/lib/format';
import { viewerFromHeaders } from '@/server/auth';
import * as events from '@/server/events';
import { browseMarkets, MARKET_SORTS, marketKinds, sparklines, type BrowseRow, type MarketSort } from '@/server/views';

export const dynamic = 'force-dynamic';

/** The selected filter link. */
const ON = 'font-semibold text-ink';

const STATUSES = ['open', 'closed', 'settled', 'all'] as const;
type Status = (typeof STATUSES)[number];

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
  const sort: MarketSort = (MARKET_SORTS as readonly string[]).includes(one(sp.sort) ?? '') ? (one(sp.sort) as MarketSort) : 'closing';

  const rows = await browseMarkets({ kind, status, sort });
  const sparks = await sparklines(rows);
  const viewer = await viewerFromHeaders(await headers());
  events.log('market.list', { accountId: viewer?.account.id ?? null });

  const href = (patch: Record<string, string>) => {
    const q = new URLSearchParams({ kind: kind ?? 'all', status, sort, ...patch });
    return `/?${q}`;
  };

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
      <div className="mt-3.5 mb-1 flex flex-wrap items-baseline gap-x-4.5 gap-y-1.5 font-sans text-[13px] text-muted">
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
          {STATUSES.map((s) => (
            <Link key={s} href={href({ status: s })} className={s === status ? ON : ''}>
              {s}
            </Link>
          ))}
        </span>
        <span className="flex gap-3">
          sort:
          {MARKET_SORTS.map((s) => (
            <Link key={s} href={href({ sort: s })} className={s === sort ? ON : ''}>
              {s}
            </Link>
          ))}
        </span>
      </div>

      {rows.length === 0 && <div className={ui.empty}>No {status === 'all' ? '' : status + ' '}markets here yet.</div>}

      {groups.map(([key, list]) => (
        <section key={key || 'all'}>
          {key && (
            <h2 className={ui.groupHeading}>
              {key} <span className="font-normal">({list.length})</span>
            </h2>
          )}
          {!key && <div className="h-3.5" />}
          {list.map((r) => (
            <Link key={r.market.id} href={`/markets/${r.market.slug}`} className="grid grid-cols-[1fr_90px_90px_110px] items-center gap-3.5 border-b border-dotted border-rule-strong py-2 hover:bg-highlight hover:no-underline narrow:grid-cols-[1fr_64px]">
              <span className="leading-[1.35]">{r.market.question}</span>
              <span className="text-right font-mono text-xs text-muted narrow:hidden" title="volume">
                {r.orderCount > 0 ? `${rep(r.volumeMicro, 0)} rep` : ''}
              </span>
              <span className="narrow:hidden">
                <Sparkline values={sparks.get(r.market.id) ?? []} />
              </span>
              <span className="text-right font-mono text-sm">{headline(r)}</span>
            </Link>
          ))}
        </section>
      ))}
    </main>
  );
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
