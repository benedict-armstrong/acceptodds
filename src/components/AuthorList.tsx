'use client';

import { useState } from 'react';
import { authorList } from '@/lib/bibliography';
import { ui } from './ui';

/** Authors named before "et al." on a collapsed list. */
const SHOWN = 3;
/** A list this long or shorter is always set in full. */
const LIMIT = 5;

/**
 * A reference's authors, in full ("A, B, and C"). A long list is cut to the
 * first few and "et al." with a "show all" to expand it, and "show less" to
 * fold it again.
 */
export function AuthorList({ names }: { names: readonly string[] }) {
  const [open, setOpen] = useState(false);
  if (names.length <= LIMIT) return <>{authorList(names)}</>;
  return (
    <>
      {open ? (
        authorList(names)
      ) : (
        <>
          {names.slice(0, SHOWN).join(', ')}, <i>et al.</i>
        </>
      )}{' '}
      <button type="button" className={`${ui.linkBtn} font-sans text-[13px]`} onClick={() => setOpen(!open)}>
        {open ? 'show less' : `show all ${names.length}`}
      </button>
    </>
  );
}
