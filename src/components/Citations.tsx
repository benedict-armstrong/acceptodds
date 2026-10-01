import Link from 'next/link';
import { bibOrder } from '@/lib/bibliography';
import { pct } from '@/lib/format';
import { headlineLabel, marketHeadline } from '@/lib/headline';
import { likelihoodClass, marketLikelihood } from '@/lib/likelihood';
import type { CitedListing, ListingCitations } from '@/server/views';
import { AuthorList } from './AuthorList';
import { MathText } from './MathText';
import { Bibliography } from './References';

/**
 * A paper's back matter (#38): its bibliography, as `../research` supplied
 * it, and the papers here that cite it, both set as ICLR sets references
 * (`lib/bibliography.ts`). An entry that is a paper here links to its page
 * and shows its odds — the main market's headline, or the decision once
 * settled — in its likelihood colour.
 */
export function Citations({ citations }: { citations: ListingCitations }) {
  const { citedBy, citedByTotal } = citations;
  const references = bibOrder(
    citations.references.map(({ reference: r, cited }) => ({
      key: r.position,
      authors: r.authors.length > 0 ? r.authors : (cited?.listing.authors ?? []),
      title: r.title,
      year: r.year,
      venue: r.venue,
      url: r.url,
      cited,
    })),
  );
  const citing = bibOrder(
    citedBy.map((c) => ({
      key: c.listing.id,
      authors: c.listing.authors,
      title: c.listing.title,
      year: null,
      venue: c.listing.kind,
      url: null,
      cited: c,
    })),
  );
  return (
    <>
      {references.length > 0 && (
        <Bibliography
          items={references.map(({ key, ...e }) => (
            <Entry key={key} {...e} />
          ))}
        />
      )}
      {citing.length > 0 && (
        <Bibliography
          heading={citedByTotal > citedBy.length ? `Cited by (${citedBy.length} of ${citedByTotal} shown)` : 'Cited by'}
          items={citing.map(({ key, ...e }) => (
            <Entry key={key} {...e} />
          ))}
        />
      )}
    </>
  );
}

/** "Title. Authors. <i>Venue</i>, year." — "Title. Authors. year." with no venue. */
function Entry({
  authors,
  title,
  year,
  venue,
  url,
  cited,
}: {
  authors: readonly string[];
  title: string;
  year: number | null;
  venue: string | null;
  url: string | null;
  cited: CitedListing | null;
}) {
  const name = <MathText text={title} />;
  return (
    <>
      {cited ? (
        <Link href={`/papers/${encodeURIComponent(cited.listing.slug)}`}>{name}</Link>
      ) : url ? (
        <a href={url} rel="noopener noreferrer" target="_blank">
          {name}
        </a>
      ) : (
        name
      )}
      .
      <span className="text-muted">
        {authors.length > 0 && (
          <>
            {' '}
            <AuthorList names={authors} />.
          </>
        )}
        {venue ? (
          <>
            {' '}
            <i>{venue}</i>
            {year !== null && `, ${year}`}.
          </>
        ) : (
          year !== null && <> {year}.</>
        )}
      </span>
      {cited && url && (
        <>
          {' '}
          <a href={url} className="font-sans text-[13px] text-accent" rel="noopener noreferrer" target="_blank">
            [link]
          </a>
        </>
      )}
      {cited?.main && <Odds main={cited.main} />}
    </>
  );
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
