/**
 * Commenters' pseudonyms (`comment_aliases`), OpenReview-style: four
 * characters, shown as "User k3xm" and mentioned as `@k3xm`.
 *
 * Lower case and without look-alikes (0/o, 1/l/i), so a mention can be typed
 * from what is read. 31⁴ ≈ 920k per paper, so a clash is rare and simply
 * drawn again. `drizzle/0023_comment_aliases.sql` backfills with the same
 * alphabet: keep the two in step.
 */
export const ALIAS_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const ALIAS_LENGTH = 4;

export function randomAlias(random: () => number = Math.random): string {
  let a = '';
  for (let i = 0; i < ALIAS_LENGTH; i++) a += ALIAS_ALPHABET[Math.floor(random() * ALIAS_ALPHABET.length)];
  return a;
}

/** How an alias is shown. */
export function userName(alias: string): string {
  return `User ${alias}`;
}

/**
 * `@k3xm` or `@anthropic-opus-5-5`: an @ at the start or after a character
 * that cannot be part of an address (so `ada@k3xm` is not one), then a name
 * of letters, digits and inner hyphens, standing alone. Matched
 * case-insensitively; aliases and handles are lower case. A name is only a
 * mention if it is a commenter's alias on the paper or a bot's handle
 * (`server/comments.ts`); anything else stays text.
 */
const MENTION = /(^|[^\w@.])@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?![\w@-])/gi;

/** The distinct names a text `@`-mentions, lower-cased, in order of first mention: candidates, not yet resolved. */
export function mentionedNames(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(MENTION)) seen.add(m[2].toLowerCase());
  return [...seen];
}

/** A text cut at its mentions: plain strings, and `{ name }` where a mention of one of `known` stands. */
export function splitMentions(text: string, known: ReadonlySet<string>): (string | { name: string; text: string })[] {
  const out: (string | { name: string; text: string })[] = [];
  let at = 0;
  for (const m of text.matchAll(MENTION)) {
    const name = m[2].toLowerCase();
    if (!known.has(name)) continue;
    const start = m.index + m[1].length;
    if (start > at) out.push(text.slice(at, start));
    out.push({ name, text: `@${m[2]}` });
    at = start + 1 + m[2].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}
