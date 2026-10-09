import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReactNode } from 'react';
import { ImageResponse } from 'next/og';
import { pct } from '@/lib/format';
import { barOrder, MAX_BAR_OUTCOMES, paletteSlot, placeLabels, shareTitleParts, TIER_HEX } from '@/lib/headline';
import { standingBand } from '@/lib/leaderboard';
import { microToFloat } from '@/lib/money';
import type { FieldSnapshot } from './field-snapshot';
import type { ShareSubject } from './share';
import type { Venue } from '@/venues';

/**
 * The link-preview images. A paper's or market's (issue #11 §1): the question
 * (`<title> @ <kind>?`, as the share text words it) and the outcome bar with
 * each outcome's price beside its label. Settled: the result. A trader's
 * (`profileImage`): their rank and the field's curve with them on it.
 * Everything on them comes from the database. Prices, not values (§1.1);
 * nothing here writes.
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

let hand: Promise<Buffer> | null = null;
/** Caveat (OFL), for the home card's handwritten note and nothing else. */
function handFont(): Promise<Buffer> {
  hand ??= readFile(join(process.cwd(), 'assets/fonts/Caveat-Regular.ttf'));
  return hand;
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

/** The outcome bar with its prices and labels on either side. */
function OutcomeBar({ legend }: { legend: ReturnType<typeof barLegend> }) {
  return (
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
  );
}

/** A paper's name, hidden: word-shaped strokes under a haze, where the home card's question leaves it blank. */
function HiddenTitle({ width, height }: { width: number; height: number }) {
  const words = [58, 34, 78, 28, 52];
  const gap = 12;
  let x = 24;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <defs>
        <filter id="haze" x="-20%" y="-60%" width="140%" height="220%">
          <feGaussianBlur stdDeviation="10" />
        </filter>
        <filter id="smudge" x="-10%" y="-50%" width="120%" height="200%">
          <feGaussianBlur stdDeviation="4" />
        </filter>
      </defs>
      <g filter="url(#smudge)">
        {words.map((w, k) => {
          const r = (
            <rect key={k} x={x} y={height / 2 - 9} width={w} height={20} rx={8} fill={INK} fillOpacity={0.45} />
          );
          x += w + gap;
          return r;
        })}
      </g>
      <g filter="url(#haze)">
        <ellipse
          cx={width * 0.27}
          cy={height / 2 + 2}
          rx={width * 0.19}
          ry={height * 0.26}
          fill="#dedad1"
          fillOpacity={0.75}
        />
        <ellipse
          cx={width * 0.55}
          cy={height / 2 - 4}
          rx={width * 0.22}
          ry={height * 0.3}
          fill="#dedad1"
          fillOpacity={0.7}
        />
        <ellipse
          cx={width * 0.74}
          cy={height / 2 + 3}
          rx={width * 0.19}
          ry={height * 0.25}
          fill="#dedad1"
          fillOpacity={0.75}
        />
      </g>
    </svg>
  );
}

/** A handwritten note ("your paper?") with a pen-drawn arrow up to the hidden title, its tip at (`left` + 40, `top` + 8). */
function CardNote({ note, left, top }: { note: string; left: number; top: number }) {
  return (
    <div style={{ display: 'flex', position: 'absolute', left, top, alignItems: 'flex-start' }}>
      <svg width={150} height={70} viewBox="0 0 150 70">
        <path
          d="M140,45 C95,58 50,48 40,8 M35.8,22.4 L40,8 L50.4,18.8"
          fill="none"
          stroke={ACCENT}
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <div
        style={{
          display: 'flex',
          marginTop: 18,
          fontFamily: 'Hand',
          fontSize: 44,
          color: ACCENT,
          transform: 'rotate(-3deg)',
        }}
      >
        {note}
      </div>
    </div>
  );
}

/**
 * The home page's link preview, and every page's without one of its own:
 * what the site asks of the venue (`venues/`), and a paper's market with the
 * paper hidden, at the prior every one of the venue's markets falls back to
 * (its outcomes' `openingPrice`) — a real price, not one made up for the
 * picture.
 */
export async function homeImage(v: Venue): Promise<ImageResponse> {
  const prior = v.market.outcomes.map((o) => ({ label: o.label, price: o.openingPrice }));
  const legend = prior.length >= 2 && prior.length <= MAX_BAR_OUTCOMES ? barLegend(prior) : null;
  return card(
    v.kind,
    <div style={BODY}>
      <div style={{ display: 'flex', marginTop: 44, fontSize: 72, lineHeight: 1.1 }}>{v.cardTitle}</div>
      <div style={{ display: 'flex', marginTop: 20, fontSize: 32, lineHeight: 1.3, color: MUTED }}>{v.lede}</div>

      <div style={{ display: 'flex', flex: 1 }} />

      <div style={{ display: 'flex', position: 'relative', alignItems: 'center', fontSize: 40, marginBottom: 8 }}>
        {v.cardNote && <CardNote note={v.cardNote} left={330} top={48} />}
        <div style={{ display: 'flex' }}>Will</div>
        <div style={{ display: 'flex', margin: '-10px 0' }}>
          <HiddenTitle width={360} height={80} />
        </div>
        <div style={{ display: 'flex' }}>{v.cardQuestion.predicate}</div>
        <div style={{ display: 'flex', marginLeft: 10, color: ACCENT }}>{v.cardQuestion.suffix}</div>
      </div>
      {legend && <OutcomeBar legend={legend} />}
    </div>,
    true,
  );
}

/** `holder`: a public position's line (#36), under the title. */
export async function previewImage(subject: ShareSubject | null, holder?: string): Promise<ImageResponse> {
  const main = subject?.main ?? null;
  const n = main?.outcomes.length ?? 0;
  const status = main?.market.status;
  const trading = status === 'open' || status === 'closed';
  const parts = subject
    ? shareTitleParts(subject.title, subject.kind, OG_TITLE_MAX)
    : { head: 'Not found', suffix: '' };
  // With no venue the suffix is a bare `?`: it belongs to the title's last word, not a word of its own.
  const [head, suffix] = parts.suffix.startsWith(' ') ? [parts.head, parts.suffix] : [parts.head + parts.suffix, ''];
  const titleSize = head.length + suffix.length > 70 ? 54 : 64;
  // One box per word so the venue can take its own colour and still wrap with the title.
  const words = [
    ...head.split(' ').map((w) => ({ w, color: INK })),
    ...suffix
      .trim()
      .split(' ')
      .filter(Boolean)
      .map((w) => ({ w, color: ACCENT })),
  ];
  const barred = main && trading && n >= 2 && n <= MAX_BAR_OUTCOMES;
  const legend = barred ? barLegend(main.outcomes) : null;
  const won =
    status === 'settled' && main ? main.outcomes.findIndex((o) => o.id === main.market.resolvedOutcomeId) : -1;
  const winner = won >= 0 ? main!.outcomes[won] : undefined;
  // The bar of a decided market is all the winner; a void one is empty.
  const endBar = winner
    ? n >= 2 && n <= MAX_BAR_OUTCOMES
      ? TIER_HEX[paletteSlot(won, n)]
      : INK
    : status === 'void'
      ? RULE
      : null;

  return card(
    subject?.kind ?? '',
    <div style={BODY}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          marginTop: 44,
          fontFamily: 'Serif',
          fontSize: titleSize,
          lineHeight: 1.15,
          maxHeight: holder ? 170 : 230,
          overflow: 'hidden',
        }}
      >
        {words.map(({ w, color }, k) => (
          <div key={k} style={{ display: 'flex', color, marginRight: titleSize * 0.25 }}>
            {w}
          </div>
        ))}
      </div>

      {holder && <div style={{ display: 'flex', marginTop: 20, fontSize: 36, color: MUTED }}>{holder}</div>}

      <div style={{ display: 'flex', flex: 1 }} />

      {legend && <OutcomeBar legend={legend} />}

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
    </div>,
  );
}

/**
 * Every preview's frame: the accent rule, the site's name, `corner` opposite
 * it, then `children` — one column box (`BODY`), never a fragment, which
 * Satori lays out as a row.
 */
const BODY = { display: 'flex', flexDirection: 'column', flex: 1 } as const;

async function card(corner: string, children: ReactNode, handwriting = false): Promise<ImageResponse> {
  return new ImageResponse(
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
        <div style={{ display: 'flex' }}>{corner}</div>
      </div>
      {children}
    </div>,
    {
      ...OG_SIZE,
      fonts: [
        { name: 'Serif', data: await serifFont(), style: 'normal', weight: 400 },
        ...(handwriting
          ? [{ name: 'Hand', data: await handFont(), style: 'normal' as const, weight: 400 as const }]
          : []),
      ],
      // Crawlers fetch previews hard, and chat apps cache the card anyway; five minutes is fresh enough.
      headers: { 'Cache-Control': 'public, max-age=300, s-maxage=300' },
    },
  );
}

// ---------------------------------------------------------------------------
// a trader's card
// ---------------------------------------------------------------------------

const CURVE_HEIGHT = 170;

export interface ProfilePreview {
  displayName: string;
  handle: string;
  institutions: readonly string[];
  /** Their place on the net-worth board; null when they are not on it. */
  standing: { rank: number; fieldSize: number; percentAhead: number | null } | null;
  /** The field's shared snapshot (`server/field-snapshot.ts`). */
  field: FieldSnapshot;
  /** Their own net worth from the board, as their page places them; null for no marker. */
  worthMicro: bigint | null;
}

/**
 * A trader's link preview: name and author line as their page sets them,
 * their rank on the net-worth board, and the field's curve (liquidation
 * value, never a mark, §1.2) with the part below them shaded and a line at
 * them — Figure 1 of their page. Only what that page already shows.
 */
export async function profileImage(p: ProfilePreview): Promise<ImageResponse> {
  const byline = [`@${p.handle}`, p.institutions.join('; ')].filter(Boolean).join(', ');
  const st = p.standing;
  const nameSize = p.displayName.length > 32 ? 52 : 64;
  const drawn = p.field.worthsMicro.length >= 2 ? fieldPaths(p.field, p.worthMicro, BAR_WIDTH, CURVE_HEIGHT) : null;
  return card(
    'Leaderboard',
    <div style={BODY}>
      <div
        style={{
          display: 'flex',
          marginTop: 40,
          fontSize: nameSize,
          lineHeight: 1.1,
          maxHeight: nameSize * 1.1,
          overflow: 'hidden',
        }}
      >
        {p.displayName}
      </div>
      <div style={{ display: 'flex', marginTop: 12, fontSize: 30, color: MUTED }}>{byline}</div>
      {st && st.percentAhead !== null && (
        <div style={{ display: 'flex', alignItems: 'baseline', marginTop: 22, fontSize: 40 }}>
          <div style={{ display: 'flex', color: ACCENT }}>{standingBand(st.percentAhead)}</div>
          <div style={{ display: 'flex', marginLeft: 12, color: INK }}>of traders</div>
        </div>
      )}

      <div style={{ display: 'flex', flex: 1 }} />

      {drawn && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <svg width={BAR_WIDTH} height={CURVE_HEIGHT} viewBox={`0 0 ${BAR_WIDTH} ${CURVE_HEIGHT}`}>
            <path d={drawn.area} fill={RULE} />
            {drawn.below && <path d={drawn.below} fill={ACCENT} fillOpacity={0.18} />}
            <path d={drawn.line} fill="none" stroke={MUTED} strokeWidth={3} strokeLinejoin="round" />
            <line x1={0} x2={BAR_WIDTH} y1={CURVE_HEIGHT - 1} y2={CURVE_HEIGHT - 1} stroke={MUTED} strokeWidth={2} />
            {drawn.at && (
              <line x1={drawn.at.x} x2={drawn.at.x} y1={0} y2={CURVE_HEIGHT} stroke={ACCENT} strokeWidth={4} />
            )}
            {drawn.at && (
              <circle cx={drawn.at.x} cy={drawn.at.y} r={8} fill={ACCENT} stroke="#fbfaf7" strokeWidth={3} />
            )}
          </svg>
          <div style={{ display: 'flex', marginTop: 14, fontSize: 24, color: MUTED }}>
            {`Net worth of all ${p.field.worthsMicro.length.toLocaleString('en')} traders who have placed an order, if each sold everything now.`}
          </div>
        </div>
      )}
    </div>,
  );
}

/**
 * The snapshot's curve as SVG paths in a `width` × `height` box: the line,
 * the area under it, the part of that area left of `worthMicro` (clamped
 * into the curve's range, as the page's chart clamps it), and the point on
 * the curve there. Plotting only.
 */
function fieldPaths(field: FieldSnapshot, worthMicro: bigint | null, width: number, height: number) {
  const [lo, hi] = field.domain;
  const n = field.curve.length - 1;
  const top = 12;
  const base = height - 1;
  const sx = (i: number) => (i / n) * width;
  const sy = (y: number) => base - y * (base - top);
  const pts = field.curve.map((y, i): [number, number] => [sx(i), sy(y)]);
  const path = (ps: [number, number][]) =>
    ps.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  const line = path(pts);
  const area = `${line}L${width},${base}L0,${base}Z`;
  if (worthMicro === null || !(hi > lo)) return { line, area, below: null, at: null };
  const t = Math.min(1, Math.max(0, (microToFloat(worthMicro) / 1_000_000 - lo) / (hi - lo)));
  const k = Math.min(n - 1, Math.floor(t * n));
  const f = t * n - k;
  const at = { x: t * width, y: sy(field.curve[k] + (field.curve[k + 1] - field.curve[k]) * f) };
  const below = `${path([...pts.slice(0, k + 1), [at.x, at.y]])}L${at.x.toFixed(1)},${base}L0,${base}Z`;
  return { line, area, below, at };
}
