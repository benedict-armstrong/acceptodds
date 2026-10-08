import Link from 'next/link';
import { Fragment } from 'react';
import { numberAffiliations } from '@/lib/authors';
import { ui } from './ui';

/** Authors named before "et al." on a list over its limit. */
const ET_AL_SHOWN = 3;

export interface Author {
  name: string;
  /** Where the name links; none, plain text. */
  href?: string;
  isBot?: boolean;
  affiliations: readonly string[];
}

/**
 * An author line as a paper sets one: names, each with the small numbers of
 * its affiliations, then the affiliations themselves, numbered, underneath
 * (`lib/authors.ts`). A group's board uses it for its members. Past `limit`
 * authors (a university's board) the line stops at the first few and "et
 * al.", as a citation would, and only the shown are numbered. A lone
 * author's affiliations go unnumbered.
 */
export function Authors({
  authors,
  limit = 12,
  affiliationHref,
}: {
  authors: readonly Author[];
  limit?: number;
  affiliationHref?: (name: string) => string;
}) {
  // Over the limit, the first few and "et al.", never most of a long list.
  const shown = authors.length > limit ? authors.slice(0, ET_AL_SHOWN) : authors;
  const { affiliations, marks } = numberAffiliations(shown);
  // One author needs no numbers to say whose affiliations they are.
  const numbered = shown.length > 1;
  return (
    <>
      <div>
        {shown.map((a, i) => (
          <Fragment key={a.href ?? a.name}>
            {i > 0 && ', '}
            <span className="whitespace-nowrap">
              {a.href ? (
                <Link href={a.href} className="text-ink">
                  {a.name}
                </Link>
              ) : (
                a.name
              )}
              {a.isBot && <span className={ui.badge}>bot</span>}
              {numbered && marks[i].length > 0 && <sup className="ml-px text-[10px]">{marks[i].join(',')}</sup>}
            </span>
          </Fragment>
        ))}
        {shown.length < authors.length && <i> et al.</i>}
      </div>
      {affiliations.length > 0 && (
        <div className="mt-1 text-[13px] text-muted">
          {affiliations.map((name, i) => (
            <Fragment key={name}>
              {i > 0 && ' '}
              <span className="whitespace-nowrap">
                {numbered && <sup className="mr-px text-[10px]">{i + 1}</sup>}
                {affiliationHref ? (
                  <Link href={affiliationHref(name)} className="text-muted">
                    <i>{name}</i>
                  </Link>
                ) : (
                  <i>{name}</i>
                )}
              </span>
            </Fragment>
          ))}
        </div>
      )}
    </>
  );
}
