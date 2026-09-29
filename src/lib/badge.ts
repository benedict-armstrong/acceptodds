import { barOrder, MAX_BAR_OUTCOMES, paletteSlot, TIER_HEX } from './headline';

/**
 * The embeddable SVG badge (issue #11 §2), shields.io-shaped: the site name
 * on the maroon accent, then the headline and a small outcome bar on the page
 * colour. Pure: `app/badge/[file]/route.ts` feeds it. Prices, not values.
 */

export interface BadgeInput {
  /** The left-hand label; omitted in the compact style. */
  label: string;
  /** The message, e.g. `67% accept`, `Spotlight ✓`, `void`. */
  message: string;
  /** Hex colour of the message text. */
  color: string;
  /** Prices by ordinal, for the bar; null for no bar. */
  prices: readonly number[] | null;
  compact?: boolean;
}

const H = 20;
const FONT = 'Verdana,Geneva,DejaVu Sans,sans-serif';
const ACCENT = '#b31b1b';
const PAPER = '#fbfaf7';
const FRAME = '#cfc8b8';

/** Verdana at 11px, near enough: the text is then fitted exactly with `textLength`. */
export function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    if (ch === ' ') w += 3.9;
    else if (ch === '%') w += 12;
    else if (/[0-9]/.test(ch)) w += 7;
    else if (/[ilj.,:;'|!]/.test(ch)) w += 3.5;
    else if (/[mw]/.test(ch)) w += 10.5;
    else if (/[A-Z]/.test(ch)) w += 7.8;
    else if (/[a-z]/.test(ch)) w += 6.6;
    else w += 8.5;
  }
  return Math.round(w);
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderBadge(b: BadgeInput): string {
  const pad = 6;
  const labelW = b.compact ? 0 : textWidth(b.label) + 2 * pad;
  const msgTextW = textWidth(b.message);
  const bars = b.prices && b.prices.length >= 2 && b.prices.length <= MAX_BAR_OUTCOMES ? b.prices : null;
  const barW = bars ? 36 : 0;
  const msgW = pad + msgTextW + (bars ? pad + barW : 0) + pad;
  const width = labelW + msgW;
  const title = b.compact ? b.message : `${b.label}: ${b.message}`;

  let segs = '';
  if (bars) {
    let x = labelW + pad + msgTextW + pad;
    const n = bars.length;
    for (const i of barOrder(n)) {
      const w = bars[i] * barW;
      if (w > 0.05) segs += `<rect x="${x.toFixed(2)}" y="7" width="${w.toFixed(2)}" height="6" fill="${TIER_HEX[paletteSlot(i, n)]}"/>`;
      x += w;
    }
    segs = `<g clip-path="url(#bar)">${segs}</g>`;
  }
  const barClip = bars
    ? `<clipPath id="bar"><rect x="${labelW + pad + msgTextW + pad}" y="7" width="${barW}" height="6" rx="1.5"/></clipPath>`
    : '';

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${H}" role="img" aria-label="${esc(title)}">`,
    `<title>${esc(title)}</title>`,
    `<defs><clipPath id="r"><rect width="${width}" height="${H}" rx="3"/></clipPath>${barClip}</defs>`,
    `<g clip-path="url(#r)">`,
    b.compact ? '' : `<rect width="${labelW}" height="${H}" fill="${ACCENT}"/>`,
    `<rect x="${labelW}" width="${msgW}" height="${H}" fill="${PAPER}"/>`,
    `</g>`,
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${H - 1}" rx="2.5" fill="none" stroke="${b.compact ? FRAME : ACCENT}"/>`,
    `<g font-family="${FONT}" font-size="11">`,
    b.compact
      ? ''
      : `<text x="${pad}" y="14" fill="#fff" textLength="${labelW - 2 * pad}" lengthAdjust="spacingAndGlyphs">${esc(b.label)}</text>`,
    `<text x="${labelW + pad}" y="14" fill="${b.color}" font-weight="bold" textLength="${msgTextW}" lengthAdjust="spacingAndGlyphs">${esc(b.message)}</text>`,
    `</g>`,
    segs,
    `</svg>`,
  ].join('');
}
