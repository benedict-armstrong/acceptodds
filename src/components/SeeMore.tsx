'use client';

import { useState, type ReactNode } from 'react';
import { ui } from './ui';

/** `children`, rendered on the server, shown only once "See N more" under where they go is clicked. */
export function SeeMore({ count, children }: { count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  if (open) return children;
  return (
    <button type="button" className={`${ui.linkBtn} mt-2 font-sans text-[13px]`} onClick={() => setOpen(true)}>
      See {count} more
    </button>
  );
}
