import type { CitedListing, Minimap as MinimapView } from '@/server/views';
import { Entry } from './Citations';
import { Minimap } from './map/Minimap';
import { References } from './References';
import { ui } from './ui';

/**
 * Papers a separate similarity service named as related, in the order it
 * gave (best first, not alphabetical) with their odds. A price, never a
 * value (§1.1). A numbered section, before the discussion (`MarketLive`'s
 * `beforeDiscussion`). Opens with the paper's piece of the map
 * (`Minimap`), when it is on the map.
 */
export function RelatedPapers({
  related,
  minimap,
  figure,
}: {
  related: CitedListing[];
  minimap: MinimapView | null;
  figure: number;
}) {
  if (related.length === 0 && !minimap) return null;
  return (
    <section>
      <h3 className={ui.groupHeading}>Related papers</h3>
      {minimap && <Minimap minimap={minimap} figure={figure} />}
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
