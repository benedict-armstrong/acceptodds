'use client';

import { useState } from 'react';
import { copyText } from './CopyButton';
import { CheckIcon, CopyIcon } from './icons';

/**
 * A read-only text box showing `value`, with a copy icon at its end: pressing
 * anywhere on it copies, and the icon becomes a tick for a moment. The text is
 * selected too, so where there is no clipboard (an insecure context) it can be
 * copied by hand.
 */
export function CopyField({
  value,
  label,
  multiline = false,
  className = '',
}: {
  value: string;
  label: string;
  /** Show `value`'s lines as they are (a BibTeX entry) rather than one truncated line. */
  multiline?: boolean;
  className?: string;
}) {
  const [done, setDone] = useState(false);
  return (
    <div
      className={`relative cursor-pointer ${className}`}
      onClick={async (e) => {
        e.currentTarget.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea')?.select();
        if (await copyText(value)) {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }
      }}
    >
      {multiline ? (
        <textarea
          readOnly
          value={value}
          aria-label={label}
          rows={value.split('\n').length}
          wrap="off"
          className="block w-full cursor-pointer resize-none overflow-x-auto border border-rule bg-white p-1.5 pr-9 font-mono text-[13px] leading-normal narrow:text-base"
        />
      ) : (
        <input
          readOnly
          value={value}
          aria-label={label}
          className="w-full cursor-pointer truncate border border-rule bg-white p-1.5 pr-9 font-mono text-[13px] leading-[normal] narrow:text-base"
        />
      )}
      <button
        type="button"
        aria-label={done ? 'Copied' : `Copy: ${label}`}
        className="absolute top-0 right-0 flex h-9 w-9 cursor-pointer items-center justify-center text-muted hover:text-ink"
      >
        {done ? <CheckIcon className="size-4 text-up" /> : <CopyIcon />}
      </button>
    </div>
  );
}
