import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';
import { pct } from '@/lib/format';
import { barOrder, MAX_BAR_OUTCOMES, paletteSlot, placeLabels, shareTitleParts, TIER_HEX } from '@/lib/headline';
import type { ShareSubject } from './share';

/**
 * The link-preview image of a paper or market (issue #11 §1): the question
 * (`<title> @ <kind>?`, as the share text words it) and the outcome bar with
 * each outcome's price beside its label. Settled: the result. Everything on it comes from the database.
 * Prices, not values (§1.1); nothing here writes.
 */

export const OG_SIZE = { width: 1200, height: 630 };

const INK = '#1d1d1d';
const MUTED = '#777';
const ACCENT = '#b31b1b';
const RULE = '#ddd'; // --color-rule

let serif: Promise<Buffer> | null = null;
function serifFont(): Promise<Buffer> {
  serif ??= readFile(join(process.cwd(), 'assets/fonts/LiberationSerif-Regular.ttf'));
  return serif;
}

/** The question for a Latin-only font: `<title> @ <kind>?`, at most ~120 characters, `@ <kind>?` kept whole. */
const OG_TITLE_MAX = 120;

const BAR_WIDTH = OG_SIZE.width - 2 * 72;
const PCT_SIZE = 30;
const LABEL_SIZE = 22;
const LABEL_GAP = 20;

/** A generous width for Latin text in the serif (Times metrics): half an em a character, a bit more for `%`. */
function textWidth(text: string, size: number): number {
  return [...text].reduce((w, c) => w + (c === '%' ? 0.85 : /[A-Z]/.test(c) ? 0.7 : 0.5), 0) * size;
}

/**
 * Each outcome, worst first, with its segment and where its price and label
 * sit: alternately below and above the bar, so neighbours never share a row,
 * then nudged apart within a row only if even that leaves them colliding.
 */
function barLegend(outcomes: readonly { label: string; price: number }[]) {
  const n = outcomes.length;
  let start = 0;
  const items = barOrder(n).map((i) => {
    const { label, price } = outcomes[i];
    const text = pct(price);
    const center = (start + price / 2) * BAR_WIDTH;
    start += price;
    const width = Math.max(textWidth(text, PCT_SIZE), textWidth(label, LABEL_SIZE));
    return { i, label, price, text, center, width, color: TIER_HEX[paletteSlot(i, n)] };
  });
  const place = (row: typeof items) => {
    const left = placeLabels(
      row.map((it) => it.center),
      row.map((it) => it.width),
      BAR_WIDTH,
      LABEL_GAP,
    );
    // A label moved off-centre leans toward its tick: flush with the edge that stopped it, or with the neighbour.
    return row.map((it, k) => {
      const shift = left[k] - (it.center - it.width / 2);
      const align = shift > 0.5 ? 'flex-start' : shift < -0.5 ? 'flex-end' : 'center';
      return { ...it, left: left[k], align };
    });
  };
  return {
    segments: items,
    below: place(items.filter((_, k) => k % 2 === 0)),
    above: place(items.filter((_, k) => k % 2 === 1)),
  };
}

type Placed = ReturnType<typeof barLegend>['below'];

/** A tick from the bar at each segment's middle, on the side its label is. */
function Ticks({ row }: { row: Placed }) {
  return (
    <div style={{ display: 'flex', position: 'relative', height: 10 }}>
      {row.map((it) => (
        <div
          key={it.i}
          style={{ position: 'absolute', left: it.center - 1.5, top: 0, width: 3, height: 10, background: it.color }}
        />
      ))}
    </div>
  );
}

/** Prices and labels, the price nearer the bar on either side. */
function Labels({ row, above }: { row: Placed; above: boolean }) {
  return (
    <div style={{ display: 'flex', position: 'relative', height: 64 }}>
      {row.map((it) => (
        <div
          key={it.i}
          style={{
            position: 'absolute',
            left: it.left,
            [above ? 'bottom' : 'top']: 2,
            width: it.width,
            display: 'flex',
            flexDirection: above ? 'column-reverse' : 'column',
            alignItems: it.align,
          }}
        >
          <div style={{ display: 'flex', fontSize: PCT_SIZE, lineHeight: 1, color: INK }}>{it.text}</div>
          <div
            style={{
              display: 'flex',
              fontSize: LABEL_SIZE,
              lineHeight: 1,
              [above ? 'marginBottom' : 'marginTop']: 6,
              color: MUTED,
            }}
          >
            {it.label}
          </div>
        </div>
      ))}
    </div>
  );
}

export async function previewImage(subject: ShareSubject | null): Promise<ImageResponse> {
  const main = subject?.main ?? null;
  const n = main?.outcomes.length ?? 0;
  const status = main?.market.status;
  const trading = status === 'open' || status === 'closed';
  const parts = subject ? shareTitleParts(subject.title, subject.kind, OG_TITLE_MAX) : { head: 'Not found', suffix: '' };
  // With no venue the suffix is a bare `?`: it belongs to the title's last word, not a word of its own.
  const [head, suffix] = parts.suffix.startsWith(' ') ? [parts.head, parts.suffix] : [parts.head + parts.suffix, ''];
  const titleSize = head.length + suffix.length > 70 ? 54 : 64;
  // One box per word so the venue can take its own colour and still wrap with the title.
  const words = [
    ...head.split(' ').map((w) => ({ w, color: INK })),
    ...suffix.trim().split(' ').filter(Boolean).map((w) => ({ w, color: ACCENT })),
  ];
  const barred = main && trading && n >= 2 && n <= MAX_BAR_OUTCOMES;
  const legend = barred ? barLegend(main.outcomes) : null;
  const won = status === 'settled' && main ? main.outcomes.findIndex((o) => o.id === main.market.resolvedOutcomeId) : -1;
  const winner = won >= 0 ? main!.outcomes[won] : undefined;
  // The bar of a decided market is all the winner; a void one is empty.
  const endBar = winner
    ? n >= 2 && n <= MAX_BAR_OUTCOMES
      ? TIER_HEX[paletteSlot(won, n)]
      : INK
    : status === 'void'
      ? RULE
      : null;

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: '#fbfaf7',
          padding: '56px 72px',
          color: INK,
          fontFamily: 'Serif',
          borderTop: `12px solid ${ACCENT}`,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 30, color: MUTED }}>
          <div style={{ display: 'flex', fontFamily: 'Serif', fontSize: 36, color: INK }}>
            accept<span style={{ color: ACCENT }}>odds</span>
            <span style={{ color: MUTED }}>.com</span>
          </div>
          <div style={{ display: 'flex' }}>{subject?.kind ?? ''}</div>
        </div>

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            marginTop: 44,
            fontFamily: 'Serif',
            fontSize: titleSize,
            lineHeight: 1.15,
            maxHeight: 230,
            overflow: 'hidden',
          }}
        >
          {words.map(({ w, color }, k) => (
            <div key={k} style={{ display: 'flex', color, marginRight: titleSize * 0.25 }}>
              {w}
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', flex: 1 }} />

        {legend && (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <Labels row={legend.above} above />
            <Ticks row={legend.above} />
            <div style={{ display: 'flex', height: 30, borderRadius: 6, overflow: 'hidden' }}>
              {legend.segments.map((it) => (
                <div key={it.i} style={{ display: 'flex', width: `${it.price * 100}%`, background: it.color }} />
              ))}
            </div>
            <Ticks row={legend.below} />
            <Labels row={legend.below} above={false} />
          </div>
        )}

        {endBar && (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', height: 30, borderRadius: 6, background: endBar }} />
            <div style={{ display: 'flex', alignItems: 'baseline', marginTop: 16, height: 64 }}>
              <div style={{ display: 'flex', fontSize: LABEL_SIZE + 4, color: MUTED, marginRight: 12 }}>
                {winner ? 'Decided' : 'Void'}
              </div>
              {winner && <div style={{ display: 'flex', fontSize: PCT_SIZE + 6, color: INK }}>{winner.label}</div>}
            </div>
          </div>
        )}
      </div>
    ),
    {
      ...OG_SIZE,
      fonts: [{ name: 'Serif', data: await serifFont(), style: 'normal', weight: 400 }],
      // Crawlers fetch previews hard, and chat apps cache the card anyway; five minutes is fresh enough.
      headers: { 'Cache-Control': 'public, max-age=300, s-maxage=300' },
    },
  );
}
