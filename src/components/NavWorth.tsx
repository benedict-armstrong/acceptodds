'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Amount } from './Amount';
import { MiniCurve } from './MiniCurve';
import type { NavGroup } from './NavGroups';
import { MobileNav } from './MobileNav';
import { Popover, PopoverContent, PopoverTrigger } from './Popover';
import { ui } from './ui';

/** Where the viewer sits, for the navbar: see `MiniCurve`. */
export interface NavStanding {
  /** The field's density, sampled evenly, peaking at 1. */
  curve: number[];
  /** The viewer's position across it, 0 to 1. */
  at: number;
}

/**
 * The navbar's figure (#17): a tiny bell curve of the net-worth field with a
 * line at the viewer (`MiniCurve`). Hovering it (or tapping, where there is no
 * hover) opens a panel below with net worth at liquidation value, cash and lifetime P&L (unrealized plus realized).
 * Without a field to draw, the net worth itself.
 *
 * A mouse click goes to `/profile` while the navbar has that link.
 * On a phone the distribution and hamburger share a trigger for the account
 * summary and navigation in one popover.
 * A panel opened by hover is only a tooltip and
 * lets the pointer through; a click pins it open, and then it takes clicks.
 */
export function NavWorth({
  handle,
  worth,
  cash,
  pnlMicro,
  standing,
  groups,
}: {
  handle: string;
  worth: string;
  cash: string;
  /** Lifetime P&L, micro-units as a decimal string: unrealized plus realized. */
  pnlMicro: string;
  standing: NavStanding | null;
  groups: NavGroup[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState<'hover' | 'pinned' | null>(null);
  const label = `Account menu, net worth ${worth}`;
  return (
    <Popover open={open !== null} onOpenChange={(o) => setOpen(o ? 'pinned' : null)}>
      <PopoverTrigger
        aria-label={label}
        className={`${ui.mono} cursor-pointer hover:text-accent narrow:inline-flex narrow:min-h-11 narrow:items-center narrow:gap-1`}
        onPointerEnter={(e) => {
          if (e.pointerType === 'mouse' && !window.matchMedia('(max-width: 720px)').matches) {
            setOpen((s) => s ?? 'hover');
          }
        }}
        onPointerLeave={(e) => e.pointerType === 'mouse' && setOpen((s) => (s === 'hover' ? null : s))}
        onClick={(e) => {
          // With a mouse, where `profile` is in the navbar, the figure is its link.
          // On a phone either part of the trigger opens the shared account menu.
          const mouse = (e.nativeEvent as PointerEvent).pointerType === 'mouse';
          if (mouse && !window.matchMedia('(max-width: 720px)').matches) {
            e.preventDefault();
            setOpen(null);
            router.push('/profile');
            return;
          }
          // Clicking a panel hover opened pins it, rather than Radix's toggle closing it.
          if (open !== 'hover') return;
          e.preventDefault();
          setOpen('pinned');
        }}
      >
        <span className="narrow:inline-flex narrow:min-w-14 narrow:items-center narrow:justify-center">
          {standing ? <MiniCurve curve={standing.curve} at={standing.at} /> : worth}
        </span>
        <span className="hidden size-11 items-center justify-center narrow:inline-flex">
          <svg
            width="20"
            height="20"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden
          >
            {open === 'pinned' ? <path d="m4 4 12 12M4 16 16 4" /> : <path d="M2 4h16M2 10h16M2 16h16" />}
          </svg>
        </span>
      </PopoverTrigger>
      <PopoverContent
        menu
        align="end"
        className={`text-[13px] ${open === 'hover' ? 'pointer-events-none' : ''}`}
        // Hover opens it; don't steal focus from the page.
        onOpenAutoFocus={(e) => {
          if (open === 'hover') e.preventDefault();
        }}
      >
        <div className="narrow:w-[min(220px,calc(100vw-64px))]">
          <p className="hidden px-1 py-1.5 font-serif text-lg break-words narrow:block">@{handle}</p>
          <hr className="my-1 hidden border-rule narrow:block" />
          <div className="flex flex-col gap-1 narrow:px-1 narrow:py-1.5">
            <div className="flex justify-between gap-4">
              <span className="text-muted">net worth</span> <b className={ui.mono}>{worth}</b>
            </div>
            <div className="flex justify-between gap-4 text-muted">
              cash <span className={ui.mono}>{cash}</span>
            </div>
            <div className="flex justify-between gap-4 text-muted">
              lifetime P&L <Amount micro={pnlMicro} signed />
            </div>
          </div>
          <MobileNav groups={groups} onNavigate={() => setOpen(null)} />
        </div>
      </PopoverContent>
    </Popover>
  );
}
