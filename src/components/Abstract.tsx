'use client';

import { useEffect, useRef, useState } from 'react';
import { ui } from '@/components/ui';

/** Collapsed, the abstract shows this many lines. */
const COLLAPSED_LINES = 3;

/**
 * A title block's abstract: headed, inset from the text width and justified,
 * as a paper's is. One longer than three lines at the current width starts
 * collapsed to them until clicked; a shorter one has no toggle.
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

  return (
    <div className="mx-auto mt-5 max-w-[min(680px,85%)] text-left text-[14px] leading-[1.55]">
      <h2 className={`${ui.boxHeading} text-center`}>Abstract</h2>
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
  );
}
