'use client';

import * as D from '@radix-ui/react-dialog';
import { useState, type ComponentProps, type ReactNode } from 'react';
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
/** The dialog's accessible name, for a `SheetContent`, which places its own heading. */
export const ModalTitle = D.Title;

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

/** How far a sheet must be dragged down, in px, to close. */
const DISMISS_DRAG = 80;

/**
 * A modal on a wide screen and a bottom sheet on a phone (`narrow`): pinned to
 * the bottom edge, sliding up, with a handle that closes it when dragged down.
 * Unlike `ModalContent` it sets no heading of its own: the children place a
 * `ModalTitle` where their design wants it. `onDismiss` closes the controlled
 * `Modal`, for the drag.
 */
export function SheetContent({
  onDismiss,
  className = '',
  children,
  ...props
}: ComponentProps<typeof D.Content> & { onDismiss: () => void }) {
  const [drag, setDrag] = useState<{ start: number; dy: number } | null>(null);
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-black/30" />
      <D.Content
        aria-describedby={undefined}
        className={`fixed top-1/2 left-1/2 z-50 max-h-[calc(100dvh-32px)] w-[min(440px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto border border-frame bg-card p-6 font-sans text-sm text-left shadow-sm outline-none narrow:top-auto narrow:bottom-0 narrow:left-0 narrow:max-h-[92dvh] narrow:w-full narrow:translate-x-0 narrow:translate-y-0 narrow:animate-sheet-up narrow:rounded-t-2xl narrow:border-x-0 narrow:border-b-0 narrow:px-5 narrow:pt-0 narrow:pb-[max(1.25rem,env(safe-area-inset-bottom))] motion-reduce:animate-none ${className}`}
        style={{
          transform: drag ? `translateY(${drag.dy}px)` : undefined,
          transition: drag ? 'none' : 'transform 0.2s ease-out',
        }}
        {...props}
      >
        <div
          aria-hidden="true"
          className="hidden cursor-grab touch-none py-3 narrow:block"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            setDrag({ start: event.clientY, dy: 0 });
          }}
          onPointerMove={(event) => {
            if (drag) setDrag({ start: drag.start, dy: Math.max(0, event.clientY - drag.start) });
          }}
          onPointerUp={() => {
            if (drag && drag.dy > DISMISS_DRAG) onDismiss();
            setDrag(null);
          }}
          onPointerCancel={() => setDrag(null)}
        >
          <div className="mx-auto h-1 w-10 rounded-full bg-rule-strong" />
        </div>
        <D.Close
          aria-label="Close"
          className="absolute top-3 right-3 cursor-pointer px-1 text-lg leading-none text-muted hover:text-ink narrow:hidden"
        >
          ×
        </D.Close>
        {children}
      </D.Content>
    </D.Portal>
  );
}
