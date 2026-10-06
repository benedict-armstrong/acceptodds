import type { CitedListing, RelatedList } from '@/server/views';
import { Entry } from './Citations';
import { ArrowUpIcon } from './icons';
import { Minimap } from './map/Minimap';
import { References } from './References';
import { ScrollLink } from './ScrollLink';
import { SeeMore } from './SeeMore';
import { ui } from './ui';

/**
 * Papers a separate similarity service named as related, in the order it
 * gave (best first, not alphabetical) with their odds. A price, never a
 * value (§1.1). A numbered section, before the discussion (`MarketLive`'s
 * `beforeDiscussion`). Opens with the paper's piece of the map
 * (`Minimap`, fetched by the browser when it comes into view), when it is
 * on the map: `minimapOf` is then its slug. The first {@link SHOWN}, and
 * the rest behind "See more".
 *
 * Until the paper has a bet the server gives out only the first few
 * (`views.listingRelatedTo`) and counts the rest, `hidden`. They are drawn
 * as blurred placeholders (no titles reach the page) under what unlocks
 * them: opening the market while the paper has none (`unlock` `open`, a
 * sentence only), or a bet, with "Place a bet ↑" scrolling up until the
 * trade box's outcome buttons sit in the window's lower third (`#trade`,
 * `ScrollLink`). There is no minimap, which would draw them.
 */
export function RelatedPapers({
  related: { related, hidden },
  minimapOf,
  figure,
  unlock,
  venue,
}: {
  related: RelatedList;
  minimapOf: string | null;
  figure: number;
  /** How the held-back papers are unlocked from here: open the market, or bet on it; `null` when neither can be done. */
  unlock: 'open' | 'bet' | null;
  /** The paper's venue, set on the placeholders. */
  venue: string | null;
}) {
  if (related.length === 0 && !minimapOf) return null;
  const entry = (c: CitedListing) => (
    <Entry
      key={c.listing.id}
      authors={c.listing.authors}
      title={c.listing.title}
      year={null}
      venue={c.listing.kind}
      url={null}
      cited={c}
    />
  );
  const locked = hidden > 0;
  const shown = related.slice(0, SHOWN);
  const more = related.slice(SHOWN);
  // Enough placeholders to fill out the list's first screen.
  const placeholders = PLACEHOLDERS.slice(0, Math.min(hidden, SHOWN - related.length));
  return (
    <section>
      <h3 className={ui.groupHeading}>Related papers</h3>
      {minimapOf && !locked && <Minimap slug={minimapOf} figure={figure} />}
      {shown.length > 0 && <References heading={null} idPrefix="related" items={shown.map(entry)} />}
      {more.length > 0 && (
        <SeeMore count={more.length}>
          <div className="mt-1.5">
            <References heading={null} idPrefix="related" start={SHOWN + 1} items={more.map(entry)} />
          </div>
        </SeeMore>
      )}
      {locked && (
        <div className="relative pt-4">
          <div aria-hidden inert className="pointer-events-none select-none">
            <References
              heading={null}
              idPrefix="related-hidden"
              start={related.length + 1}
              items={placeholders.map((title) => (
                <Entry key={title} authors={[]} title={title} year={null} venue={venue} url={null} cited={null} />
              ))}
            />
          </div>
          {/* The blur is a backdrop over the placeholders, wider than them so its edges fall on plain page, and
              faded in by a mask over the blank above them: soft at the top, and full from the first row. */}
          <div className="absolute -inset-x-6 top-0 bottom-0 narrow:-inset-x-3 backdrop-blur-[6px] [-webkit-mask-image:linear-gradient(to_bottom,transparent,black_1rem)] [mask-image:linear-gradient(to_bottom,transparent,black_1rem)]" />
          <div className="absolute -inset-x-6 top-0 bottom-0 bg-linear-to-b narrow:-inset-x-3 from-transparent from-40% to-bg" />
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 text-center">
            <p className="font-sans text-sm text-ink">
              {unlock === 'open'
                ? 'See more related submissions when the market opens.'
                : `${unlock === 'bet' ? 'Place a bet on this paper' : 'Once this paper has a bet,'} to see more related papers.`}
            </p>
            {/* With no market yet, `JevPrice` is just above: the sentence says enough. */}
            {unlock === 'bet' && (
              <ScrollLink
                to="trade"
                part="[data-outcomes]"
                at={2 / 3}
                className={ui.btn({ inline: true, flush: true })}
              >
                Place a bet
                <ArrowUpIcon className="ml-1.5 inline-block size-[1em] align-[-0.125em]" />
              </ScrollLink>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** How many show before "See more"; the rest, all the service sent, after it. */
const SHOWN = 10;

/** Stand-ins for the related papers held back, only ever shown blurred: shaped like titles, saying nothing. */
const PLACEHOLDERS = [
  'Lorem ipsum dolor sit amet: consectetur adipiscing elit for sed do eiusmod tempor',
  'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris',
  'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla',
  'Excepteur sint occaecat cupidatat non proident',
  'Sunt in culpa qui officia deserunt mollit anim id est laborum via sed ut perspiciatis',
  'Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit',
  'Neque porro quisquam est, qui dolorem ipsum quia dolor sit amet, consectetur, adipisci velit',
];
