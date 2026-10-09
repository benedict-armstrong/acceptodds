/** An institution is named only once this many traders are from it, so no one person makes it show. */
const MIN_TRADERS = 2;

/** A copy of `items` in random order (Fisher–Yates). */
function shuffle<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * "Join traders from" and a slow strip of institution names, under the home
 * page's title, in a fresh random order on every render. Names, not logos:
 * a logo reads as an endorsement the institution never gave. Pure CSS: the
 * row is drawn twice and slid by half its width, so it loops without a
 * seam. Under reduced motion it stands still (the second copy is then
 * hidden).
 */
export function InstitutionStrip({ institutions }: { institutions: { name: string; traders: number }[] }) {
  const names = shuffle(institutions.filter((i) => i.traders >= MIN_TRADERS).map((i) => i.name));
  if (names.length < 4) return null;
  const row = (copy: number) => (
    <ul
      aria-hidden={copy > 0 || undefined}
      className={`flex shrink-0 items-baseline ${copy > 0 ? 'motion-reduce:hidden' : ''}`}
    >
      {names.map((name) => (
        <li key={name} className="shrink-0 whitespace-nowrap after:px-6 after:text-faint after:content-['·']">
          {name}
        </li>
      ))}
    </ul>
  );
  return (
    <section aria-label="Where our traders are from" className="mt-4 flex items-baseline gap-3">
      <span className="shrink-0 font-sans text-[12px] text-muted">Join traders from</span>
      <div className="min-w-0 flex-1 overflow-hidden font-serif text-[14px] text-subtle italic [mask-image:linear-gradient(to_right,transparent,black_6%,black_94%,transparent)]">
        <div className="flex w-max animate-marquee motion-reduce:animate-none">
          {row(0)}
          {row(1)}
        </div>
      </div>
    </section>
  );
}
