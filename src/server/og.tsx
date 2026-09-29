import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ImageResponse } from 'next/og';
import { barOrder, MAX_BAR_OUTCOMES, paletteSlot, TIER_HEX } from '@/lib/headline';
import { LIKELIHOOD_BAND, marketLikelihood } from '@/lib/likelihood';
import { siteUrl, teaser, type ShareSubject } from './share';

/**
 * The link-preview image of a paper or market (issue #11 §1): the title, the
 * outcome bar **without numbers**, a band ("Leaning accept"), and a teaser
 * (the week's move, or how many traders). The exact prices are the reason to
 * click. Settled: the result. Everything on it comes from the database.
 * Prices, not values (§1.1); nothing here writes.
 */

export const OG_SIZE = { width: 1200, height: 630 };

const INK = '#1d1d1d';
const MUTED = '#777';
const ACCENT = '#b31b1b';
const BAND_COLOR = { accept: '#3d7a4f', reject: '#a24a3f', 'toss-up': INK } as const;

let serif: Promise<Buffer> | null = null;
function serifFont(): Promise<Buffer> {
  serif ??= readFile(join(process.cwd(), 'assets/fonts/LiberationSerif-Regular.ttf'));
  return serif;
}

/** A title for a Latin-only font: TeX dollar signs dropped, at most ~110 characters. */
function cleanTitle(t: string): string {
  const s = t.replace(/\$/g, '').replace(/\s+/g, ' ').trim();
  if (s.length <= 110) return s;
  const cut = s.slice(0, 109);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 60 ? cut.lastIndexOf(' ') : 109)}…`;
}

export async function previewImage(subject: ShareSubject | null): Promise<ImageResponse> {
  const main = subject?.main ?? null;
  const n = main?.outcomes.length ?? 0;
  const status = main?.market.status;
  const trading = status === 'open' || status === 'closed';
  const likely = main ? marketLikelihood({ ...main.market, outcomes: main.outcomes }) : null;
  const winner = status === 'settled' ? main?.outcomes.find((o) => o.id === main.market.resolvedOutcomeId) : undefined;
  const hint = main ? await teaser(main) : null;
  const link = `${siteUrl().replace(/^https?:\/\//, '')}${subject?.sharePath ?? ''}`;

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
          </div>
          <div style={{ display: 'flex' }}>{subject?.kind ?? ''}</div>
        </div>

        <div
          style={{
            display: 'flex',
            marginTop: 44,
            fontFamily: 'Serif',
            fontSize: subject && subject.title.length > 70 ? 54 : 64,
            lineHeight: 1.15,
            maxHeight: 230,
            overflow: 'hidden',
          }}
        >
          {subject ? cleanTitle(subject.title) : 'Not found'}
        </div>

        <div style={{ display: 'flex', flex: 1 }} />

        {main && trading && n >= 2 && n <= MAX_BAR_OUTCOMES && (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', height: 30, borderRadius: 6, overflow: 'hidden' }}>
              {barOrder(n).map((i) => (
                <div
                  key={i}
                  style={{ display: 'flex', width: `${main.outcomes[i].price * 100}%`, background: TIER_HEX[paletteSlot(i, n)] }}
                />
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 12, fontSize: 24, color: MUTED }}>
              {barOrder(n).map((i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center' }}>
                  <div
                    style={{ width: 16, height: 16, borderRadius: 3, marginRight: 8, background: TIER_HEX[paletteSlot(i, n)] }}
                  />
                  {main.outcomes[i].label}
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 34 }}>
          <div style={{ display: 'flex', fontSize: 40, color: likely ? BAND_COLOR[likely] : INK }}>
            {winner
              ? `Decided: ${winner.label}`
              : status === 'void'
                ? 'Void'
                : likely && subject?.listing
                  ? LIKELIHOOD_BAND[likely]
                  : main
                    ? 'What are the odds?'
                    : ''}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', fontSize: 26, color: MUTED }}>
            {hint && <div style={{ display: 'flex' }}>{hint}</div>}
            <div style={{ display: 'flex', color: ACCENT }}>{link}</div>
          </div>
        </div>
      </div>
    ),
    {
      ...OG_SIZE,
      fonts: [{ name: 'Serif', data: await serifFont(), style: 'normal', weight: 400 }],
      // Crawlers fetch previews hard; five minutes is fresh enough for a band.
      headers: { 'Cache-Control': 'public, max-age=300, s-maxage=300' },
    },
  );
}
