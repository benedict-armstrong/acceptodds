import Link from 'next/link';
import { pct } from '@/lib/format';
import { headlineLabel, marketHeadline } from '@/lib/headline';
import { likelihoodClass, marketLikelihood } from '@/lib/likelihood';
import type { CitedListing, ListingCitations } from '@/server/views';
import { MathText } from './MathText';
import { References } from './References';

/**
 * A paper's back matter (#38): its bibliography, as `../research` supplied
 * it, and the papers here that cite it. An entry that is a paper here links
 * to its page and shows its odds — the main market's headline, or the
 * decision once settled — in its likelihood colour.
 */
export function Citations({ citations }: { citations: ListingCitations }) {
  const { references, citedBy, citedByTotal } = citations;
  return (
    <>
      {references.length > 0 && (
        <References
          items={references.map(({ reference: r, cited }) => (
            <Entry
              key={r.position}
              authors={r.authors.length > 0 ? r.authors : (cited?.listing.authors ?? [])}
              title={r.title}
              url={r.url}
              venue={r.year?.toString() ?? null}
              cited={cited}
            />
          ))}
        />
      )}
      {citedBy.length > 0 && (
        <References
          heading={citedByTotal > citedBy.length ? `Cited by (${citedBy.length} of ${citedByTotal} shown)` : 'Cited by'}
          idPrefix="cited-by"
          items={citedBy.map((c) => (
            <Entry
              key={c.listing.id}
              authors={c.listing.authors}
              title={c.listing.title}
              url={null}
              venue={c.listing.kind}
              cited={c}
            />
          ))}
        />
      )}
    </>
  );
}

function Entry({
  authors,
  title,
  url,
  venue,
  cited,
}: {
  authors: string[];
  title: string;
  url: string | null;
  venue: string | null;
  cited: CitedListing | null;
}) {
  const name = <MathText text={title} />;
  return (
    <span>
      {authors.length > 0 && <>{authorLine(authors)}. </>}
      {cited ? (
        <Link href={`/papers/${encodeURIComponent(cited.listing.slug)}`}>{name}</Link>
      ) : url ? (
        <a href={url} rel="noopener noreferrer" target="_blank">
          {name}
        </a>
      ) : (
        name
      )}
      .{venue && <> {venue}.</>}
      {cited && url && (
        <>
          {' '}
          <a href={url} className="font-sans text-[13px] text-accent" rel="noopener noreferrer" target="_blank">
            [link]
          </a>
        </>
      )}
      {cited?.main && <Odds main={cited.main} />}
    </span>
  );
}

/** Up to five names in full, else the first and "et al.", as a bibliography does. */
function authorLine(authors: string[]): string {
  return authors.length <= 5 ? authors.join(', ') : `${authors[0]} et al.`;
}

function Odds({ main }: { main: NonNullable<CitedListing['main']> }) {
  const m = { ...main.market, outcomes: main.outcomes };
  const look = likelihoodClass(marketLikelihood(m));
  let text: string;
  if (main.market.status === 'settled') {
    text = main.outcomes.find((o) => o.id === main.market.resolvedOutcomeId)?.label ?? 'settled';
  } else {
    const h = marketHeadline(m);
    text =
      h === null
        ? '—'
        : `${pct(h)} ${headlineLabel(
            main.outcomes.map((o) => o.label),
            true,
          )}`;
  }
  return (
    <span className={`ml-1.5 rounded-[3px] px-1.5 font-mono text-[12px] whitespace-nowrap ${look.chip}`}>{text}</span>
  );
}
