'use client';

import * as P from '@radix-ui/react-popover';
import type { ComponentProps } from 'react';

/**
 * A popover in the site's look: Radix's primitive (what shadcn/ui's Popover
 * wraps), which handles focus, Escape, outside clicks and collision with the
 * viewport edge, styled with our tokens instead of shadcn's theme.
 */
export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
/** Closes the popover when its child is used: wrap a menu item (`asChild`) so picking it dismisses the menu. */
export const PopoverClose = P.Close;

export function PopoverContent({
  className = '',
  align = 'center',
  sideOffset = 6,
  menu = false,
  ...props
}: ComponentProps<typeof P.Content> & {
  /** A short list of links: as wide as its items, not a panel. */
  menu?: boolean;
}) {
  return (
    <P.Portal>
      <P.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={16}
        className={`z-50 ${menu ? 'flex min-w-32 flex-col gap-1 px-3 py-2' : 'w-[min(460px,calc(100vw-32px))] p-3.5'} border border-frame bg-card font-sans text-sm text-left shadow-sm outline-none ${className}`}
        {...props}
      />
    </P.Portal>
  );
}
