import Link from 'next/link';
import { headers } from 'next/headers';
import { CompareChart } from '@/components/CompareChart';
import { BoardPicker } from '@/components/BoardPicker';
import { RememberVenue } from '@/components/RememberVenue';
import { TableNotes } from '@/components/TableNotes';
import { TitleBlock } from '@/components/TitleBlock';
import { ui } from '@/components/ui';
import { SERIES, sharedDensities, summarize, type FieldSummary } from '@/lib/compare';
import { REP, rep } from '@/lib/format';
import { comparePath, institutionPath } from '@/lib/links';
import { microToFloat } from '@/lib/money';
import { authHref } from '@/lib/return-to';
import { viewerFromHeaders } from '@/server/auth';
import { currentVenue } from '@/server/current-venue';
import * as events from '@/server/events';
import { leaderboardStandings, marketKinds, tradedAccountIds, traderInstitutions } from '@/server/views';

export const dynamic = 'force-dynamic';

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Micro-units as whole units, for plotting only. */
const toUnits = (micro: bigint) => microToFloat(micro) / 1_000_000;

/**
 * Two institutions side by side (`?a=&b=`, in one venue: `?kind=`, else the
 * navbar's), reached from the leaderboard's "Compare institutions". Each is
 * its traders who have placed an order there, as an institution's board
 * draws its Figure 1: Figure 1 overlays their net worths at liquidation
 * value (never a mark, §1.2) with each mean marked, and Table 1 sets their
 * averages. A trader confirmed at both counts in both. Signed out, the
 * figures are held back, as the leaderboard holds back net worth.
 */
export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const pickedKind = one(sp.kind)?.trim() || null;
  const navVenue = await currentVenue();
  const kind = pickedKind ?? navVenue;
  const a = one(sp.a)?.trim() || null;
  const b = one(sp.b)?.trim() || null;
  // An institution is compared with another, never itself: the same one twice leaves the second side to pick.
  const names = [a, b === a ? null : b];

  const viewer = await viewerFromHeaders(await headers());
  const [institutions, kinds, ...boards] = await Promise.all([
    traderInstitutions(),
    marketKinds(),
    ...names.map((name) =>
      name === null ? [] : leaderboardStandings({ kind, basis: 'net_worth', institution: name }),
    ),
  ]);
  const traded = await tradedAccountIds(boards.flatMap((b) => b.map((r) => r.accountId)));
  const fields = boards.map((b) => b.filter((r) => traded.has(r.accountId)));
  events.log('leaderboard.read', { accountId: viewer?.account.id ?? null });

  const picked = names.every((n) => n !== null);
  const sides = picked
    ? names.map((name, k) => ({
        name: name!,
        summary: summarize(fields[k]),
        values: fields[k].map((r) => toUnits(r.netWorthMicro)).sort((x, y) => x - y),
      }))
    : [];
  const shape = sharedDensities(sides.map((s) => s.values));
  const drawable = sides.some((s) => s.values.length > 1) && sides.every((s) => s.values.length > 0);
  const compareHref = comparePath(names[0], names[1], pickedKind);

  const yours = viewer?.account.institutions ?? [];
  // Each side's name is a find box over the institutions, as the leaderboard's title names its board.
  const picker = (k: 0 | 1) => {
    const swap = (name: string) =>
      k === 0 ? comparePath(name, names[1], pickedKind) : comparePath(names[0], name, pickedKind);
    // The other side's institution is not offered.
    const other = names[1 - k];
    const option = (name: string, note?: number) => ({
      key: name,
      label: name,
      href: swap(name),
      note: note === undefined ? undefined : String(note),
    });
    return (
      <BoardPicker
        current={{ label: names[k] ?? 'an institution', href: compareHref }}
        mine={[
          { section: 'Your institutions', options: yours.filter((n) => n !== other).map((n) => option(n)) },
          {
            section: 'All institutions',
            options: institutions
              .filter((i) => i.name !== other && !yours.includes(i.name))
              .map((i) => option(i.name, i.traders)),
          },
        ]}
        institutions={[]}
        placeholder="Find an institution"
        tone={k === 0 ? 'text-accent' : 'text-tier-4'}
      />
    );
  };

  return (
    <main className={ui.page}>
      {pickedKind && kinds.some((k) => k.kind === pickedKind) && (
        <RememberVenue kind={pickedKind} stale={pickedKind !== navVenue} />
      )}
      <TitleBlock
        above={kind}
        title={
          viewer ? (
            <>
              {picker(0)} vs {picker(1)}
            </>
          ) : (
            // Signed out there is nothing to compare, so nothing to pick.
            'Compare institutions'
          )
        }
      >
        <div className="mt-2 font-sans text-[13px]">
          <Link href={pickedKind ? `/leaderboard?kind=${encodeURIComponent(pickedKind)}` : '/leaderboard'}>
            ← back to the leaderboard
          </Link>
        </div>
      </TitleBlock>

      {!viewer ? (
        <p className="text-center font-sans text-[13px] text-muted">
          <Link href={authHref('/signin', compareHref)}>Sign in</Link> to compare institutions&rsquo; net worth and P/L.
        </p>
      ) : !picked ? (
        <div className={`${ui.empty} text-center`}>Pick two institutions in the title to compare their traders.</div>
      ) : (
        <>
          {drawable && (
            <section aria-label="The two fields" className="mt-4">
              <CompareChart
                domain={shape.domain}
                series={sides.map((s, k) => ({
                  name: s.name,
                  curve: shape.curves[k],
                  values: s.values,
                  mean: s.summary.meanNetWorthMicro === null ? null : toUnits(s.summary.meanNetWorthMicro),
                }))}
              />
              <p className={ui.caption}>
                <b>Figure 1.</b> Net worth of the traders who have placed an order, if each sold everything now:{' '}
                {sides.map((s, k) => (
                  <span key={s.name}>
                    {k > 0 && ' and '}
                    <span className={`mr-1 inline-block size-2 align-middle ${SERIES[k].swatch}`} />
                    {s.name}
                  </span>
                ))}
                . Dashed lines are each institution&rsquo;s mean. Square-root scale.
              </p>
            </section>
          )}
          <div className={ui.tableScroll}>
            <table className={ui.table}>
              <caption className={ui.tableCaption}>
                <b>Table 1.</b> Average performance in {kind}. Column leaders are bold.
              </caption>
              <thead>
                <tr>
                  <th className={ui.th()}>Institution</th>
                  <th className={ui.th(true)}>Traders</th>
                  <th className={ui.th(true)}>
                    Mean net worth<sup className={ui.mark}>a</sup>
                  </th>
                  <th className={ui.th(true)}>Median net worth</th>
                  <th className={ui.th(true)}>
                    Mean unrealized P/L<sup className={ui.mark}>b</sup>
                  </th>
                  <th className={ui.th(true)}>
                    Mean settled P/L<sup className={ui.mark}>c</sup>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sides.map((s, k) => (
                  <Row
                    key={s.name}
                    name={s.name}
                    swatch={SERIES[k].swatch}
                    href={institutionPath(s.name, pickedKind)}
                    summary={s.summary}
                    other={sides[1 - k].summary}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <TableNotes
            notes={[
              ['a', 'Cash plus the proceeds from selling all holdings now.'],
              ['b', 'Gain on open holdings.'],
              ['c', 'Profit on settled markets.'],
            ]}
          />
        </>
      )}
    </main>
  );
}

/** Bold when `v` is strictly ahead of the other institution's. */
function lead(v: bigint | null, other: bigint | null): string {
  return v !== null && (other === null || v > other) ? 'font-bold' : '';
}

function Row({
  name,
  swatch,
  href,
  summary: s,
  other: o,
}: {
  name: string;
  swatch: string;
  href: string;
  summary: FieldSummary;
  other: FieldSummary;
}) {
  const money = (v: bigint | null) => (v === null ? '—' : `${rep(v)} ${REP}`);
  return (
    <tr>
      <td className={ui.td}>
        <span className={`mr-1.5 inline-block size-2 align-middle ${swatch}`} />
        <Link href={href} className="text-ink">
          {name}
        </Link>
      </td>
      <td className={`${ui.td} ${ui.num}`}>{s.traders.toLocaleString('en')}</td>
      <td className={`${ui.td} ${ui.num} ${lead(s.meanNetWorthMicro, o.meanNetWorthMicro)}`}>
        {money(s.meanNetWorthMicro)}
      </td>
      <td className={`${ui.td} ${ui.num} ${lead(s.medianNetWorthMicro, o.medianNetWorthMicro)}`}>
        {money(s.medianNetWorthMicro)}
      </td>
      <td
        className={`${ui.td} ${ui.num} ${s.meanUnrealizedPnlMicro === null ? '' : ui.pnl(s.meanUnrealizedPnlMicro)} ${lead(s.meanUnrealizedPnlMicro, o.meanUnrealizedPnlMicro)}`}
      >
        {money(s.meanUnrealizedPnlMicro)}
      </td>
      <td
        className={`${ui.td} ${ui.num} ${s.meanSettledPnlMicro === null ? '' : ui.pnl(s.meanSettledPnlMicro)} ${lead(s.meanSettledPnlMicro, o.meanSettledPnlMicro)}`}
      >
        {money(s.meanSettledPnlMicro)}
      </td>
    </tr>
  );
}
