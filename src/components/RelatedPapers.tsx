import type { CitedListing } from '@/server/views';
import { Entry } from './Citations';
import { Bibliography } from './References';

/**
 * Papers a separate similarity service named as related, set as back matter
 * in the order it gave (best first, not alphabetical) with their odds. A
 * price, never a value (§1.1).
 */
export function RelatedPapers({ related }: { related: CitedListing[] }) {
  if (related.length === 0) return null;
  return (
    <Bibliography
      heading="Related papers"
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
  );
}
