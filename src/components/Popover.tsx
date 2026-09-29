'use client';

import * as P from '@radix-ui/react-popover';
import type { ComponentProps } from 'react';
import { ui } from './ui';

/**
 * A popover in the site's look: Radix's primitive (what shadcn/ui's Popover
 * wraps), which handles focus, Escape, outside clicks and collision with the
 * viewport edge, styled with our tokens instead of shadcn's theme.
 */
export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;

export function PopoverContent({
  className = '',
  align = 'center',
  sideOffset = 6,
  ...props
}: ComponentProps<typeof P.Content>) {
  return (
    <P.Portal>
      <P.Content
        align={align}
        sideOffset={sideOffset}
        collisionPadding={16}
        className={`z-50 w-[min(460px,calc(100vw-32px))] text-left shadow-sm outline-none ${ui.box} ${className}`}
        {...props}
      />
    </P.Portal>
  );
}
