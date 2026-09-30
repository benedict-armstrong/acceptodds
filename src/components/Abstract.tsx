'use client';

import { useEffect, useRef, useState } from 'react';
import { ui } from '@/components/ui';

/** Collapsed, the abstract shows this many lines. */
const COLLAPSED_LINES = 3;

/**
 * Every title block's abstract (papers, traders, boards, the home page,
 * `/how-it-works`): headed, inset from the text width and justified, as a
 * paper's is; one shorter than a line is centred. One longer than three
 * lines at the current width starts collapsed to them until clicked; a
 * shorter one has no toggle.
 */
export function Abstract({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);

  // Whether the full text runs past the collapsed lines. `scrollHeight` is
  // the full height whether or not it is clamped, so this holds either way,
  // and is measured again whenever the width changes.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const line = parseFloat(getComputedStyle(el).lineHeight);
      setOverflows(el.scrollHeight > COLLAPSED_LINES * line + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text]);

  // The text sits in a shrink-to-fit box centred in the column: a one-line
  // abstract is only as wide as itself, so it is centred; a longer one fills
  // the column and is justified, its last line flush left as a paper's.
  return (
    <div className="mx-auto mt-5 max-w-[min(680px,85%)] text-center text-[14px] leading-[1.55]">
      <h2 className={`${ui.boxHeading} text-center`}>Abstract</h2>
      <div className="inline-block max-w-full text-left">
        <p ref={ref} className={`whitespace-pre-line text-justify hyphens-auto ${open ? '' : 'line-clamp-3'}`}>
          {text}
        </p>
        {overflows && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className={`mt-0.5 block font-sans text-[13px] ${ui.linkBtn}`}
            aria-expanded={open}
          >
            {open ? 'show less' : 'show more'}
          </button>
        )}
      </div>
    </div>
  );
}
