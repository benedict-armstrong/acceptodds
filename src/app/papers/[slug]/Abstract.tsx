'use client';

import { useState } from 'react';

/** Longer than this and the abstract starts collapsed to three lines. */
const COLLAPSE_OVER = 280;

/** The listing's summary, collapsed to a few lines until clicked. */
export function Abstract({ text }: { text: string }) {
  const long = text.length > COLLAPSE_OVER;
  const [open, setOpen] = useState(!long);
  return (
    <div className="mx-auto mt-3 max-w-[680px] text-[14px] leading-[1.55]">
      <span className="font-sans text-xs font-semibold uppercase tracking-[.06em] text-muted">Abstract </span>
      <p className={`inline whitespace-pre-line ${open ? '' : 'line-clamp-3'}`}>{text}</p>
      {long && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="mt-0.5 block cursor-pointer font-sans text-[13px] text-accent hover:underline"
          aria-expanded={open}
        >
          {open ? 'show less' : 'show more'}
        </button>
      )}
    </div>
  );
}
