'use client';

import { useState } from 'react';
import { MiniCurve } from './MiniCurve';
import { Popover, PopoverContent, PopoverTrigger } from './Popover';
import { ui } from './ui';

/** Where the viewer sits, for the navbar: see `MiniCurve`. */
export interface NavStanding {
  /** The field's density, sampled evenly, peaking at 1. */
  curve: number[];
  /** The viewer's position across it, 0 to 1. */
  at: number;
  /** "about #12 of 340", from the viewer's live net worth placed on the field. */
  rank: string;
  /** "ahead of 96% of traders", or `null` in a field of one. */
  ahead: string | null;
}

/**
 * The navbar's figure (#17): a tiny bell curve of the net-worth field with a
 * line at the viewer (`MiniCurve`). Hovering it (or tapping, where there is no
 * hover) opens a panel below with net worth at liquidation value, cash, and
 * the rank and percentile. Without a field to draw, the net worth itself.
 */
export function NavWorth({ worth, cash, standing }: { worth: string; cash: string; standing: NavStanding | null }) {
  const [open, setOpen] = useState(false);
  const label = standing
    ? `Net worth ${worth}; ${standing.rank}${standing.ahead ? `, ${standing.ahead}` : ''}`
    : `Net worth ${worth}`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={label}
        className={`${ui.mono} cursor-pointer hover:text-accent`}
        onPointerEnter={(e) => e.pointerType === 'mouse' && setOpen(true)}
        onPointerLeave={(e) => e.pointerType === 'mouse' && setOpen(false)}
      >
        {standing ? <MiniCurve curve={standing.curve} at={standing.at} /> : worth}
      </PopoverTrigger>
      <PopoverContent
        menu
        align="end"
        className="pointer-events-none text-[13px]"
        // Hover opens it; don't steal focus from the page.
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <div>
          <span className="text-muted">net worth</span> <b className={ui.mono}>{worth}</b>
        </div>
        <div className="text-muted">
          cash <span className={ui.mono}>{cash}</span>
        </div>
        {standing && (
          <div className="mt-1 border-t border-rule pt-1">
            {standing.rank} on the net-worth board
            {standing.ahead && <div className="text-muted">{standing.ahead}</div>}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
