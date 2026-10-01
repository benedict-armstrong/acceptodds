/**
 * The text a trader's "share" copies: who they are, where they stand on the
 * net-worth board (liquidation value, never a mark, §1.2) and the link, with
 * the standing drawn as a plain-ASCII bar so it survives any chat app. Pure.
 */

/** Cells in the standing bar, not counting the marker. */
export const STANDING_BAR_WIDTH = 20;

/**
 * The field as a bar, worst on the left, with `|` where the trader stands:
 * `#` for the share of the others they are ahead of, `-` for the rest, e.g.
 * `[###############|-----]`. `percentAhead` is the board's, already rounded
 * down, and the marker is rounded down from it too, so it never flatters.
 */
export function standingBar(percentAhead: number, width = STANDING_BAR_WIDTH): string {
  const ahead = Math.min(width, Math.max(0, Math.floor((percentAhead / 100) * width)));
  return `[${'#'.repeat(ahead)}|${'-'.repeat(width - ahead)}]`;
}

export interface ProfileShareInput {
  displayName: string;
  handle: string;
  site: string;
  /** Absolute URL of the trader's public page. */
  url: string;
  /** Their place on the net-worth board; null when they are not on it. */
  standing: {
    rank: number;
    fieldSize: number;
    percentAhead: number | null;
  } | null;
}

/**
 * E.g.
 *
 *     Ada Lovelace (@ada) on acceptodds
 *     #12 of 340 traders, ahead of 96%
 *     [###################|-]
 *     https://acceptodds.com/people/ada
 *
 * The bar only when there is someone to be ahead of.
 */
export function profileShareText(s: ProfileShareInput): string {
  const lines = [`${s.displayName} (@${s.handle}) on ${s.site}`];
  const st = s.standing;
  if (st) {
    const ahead = st.percentAhead === null ? '' : `, ahead of ${st.percentAhead}%`;
    lines.push(`#${st.rank.toLocaleString('en')} of ${st.fieldSize.toLocaleString('en')} traders${ahead}`);
    if (st.percentAhead !== null) lines.push(standingBar(st.percentAhead));
  }
  lines.push(s.url);
  return lines.join('\n');
}
