import type { CitedListing } from '@/server/views';
import { Entry } from './Citations';
import { Minimap } from './map/Minimap';
import { References } from './References';
import { ui } from './ui';

/**
 * Papers a separate similarity service named as related, in the order it
 * gave (best first, not alphabetical) with their odds. A price, never a
 * value (§1.1). A numbered section, before the discussion (`MarketLive`'s
 * `beforeDiscussion`). Opens with the paper's piece of the map
 * (`Minimap`, fetched by the browser when it comes into view), when it is
 * on the map: `minimapOf` is then its slug.
 */
export function RelatedPapers({
  related,
  minimapOf,
  figure,
}: {
  related: CitedListing[];
  minimapOf: string | null;
  figure: number;
}) {
  if (related.length === 0 && !minimapOf) return null;
  return (
    <section>
      <h3 className={ui.groupHeading}>Related papers</h3>
      {minimapOf && <Minimap slug={minimapOf} figure={figure} />}
      {related.length > 0 && (
        <References
          heading={null}
          idPrefix="related"
          items={related.map((c) => (
            <Entry
              key={c.listing.id}
              authors={c.listing.authors}
              title={c.listing.title}
              year={null}
              venue={c.listing.kind}
              url={null}
              cited={c}
            />
          ))}
        />
      )}
    </section>
  );
}
