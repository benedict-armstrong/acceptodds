'use client';

import * as D from '@radix-ui/react-dialog';
import type { ComponentProps, ReactNode } from 'react';
import { ui } from './ui';

/**
 * A modal dialog in the site's look: Radix's primitive (what shadcn/ui's
 * Dialog wraps), which traps focus, closes on Escape and on the backdrop, and
 * locks page scroll, styled with our tokens. The counterpart of `Popover` for
 * anything that should take over the page rather than float beside it.
 */
export const Modal = D.Root;
export const ModalTrigger = D.Trigger;
/** Closes the modal when its child is used (`asChild`). */
export const ModalClose = D.Close;

export function ModalContent({
  title,
  titleClassName = ui.runIn,
  wide = false,
  className = '',
  children,
  ...props
}: Omit<ComponentProps<typeof D.Content>, 'title'> & {
  /** Required: it is the dialog's accessible name, and shown as its heading. */
  title: ReactNode;
  /** A title block for guided flows; defaults to the site's run-in heading. */
  titleClassName?: string;
  /** For content with long lines (a code block): 640px rather than 380px. */
  wide?: boolean;
}) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-black/30" />
      <D.Content
        aria-describedby={undefined}
        className={`fixed top-1/2 left-1/2 z-50 ${wide ? 'w-[min(640px,calc(100vw-32px))]' : 'w-[min(380px,calc(100vw-32px))]'} -translate-x-1/2 -translate-y-1/2 border border-frame bg-card p-4 font-sans text-sm text-left shadow-sm outline-none ${className}`}
        {...props}
      >
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <D.Title className={titleClassName}>{title}</D.Title>
          <D.Close aria-label="Close" className="cursor-pointer px-1 text-lg leading-none text-muted hover:text-ink">
            ×
          </D.Close>
        </div>
        {children}
      </D.Content>
    </D.Portal>
  );
}
