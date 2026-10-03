'use client';

import { useState, type ReactNode } from 'react';
import { track, type EventData } from '@/lib/track';
import { ui } from './ui';

/** Copies `value`; false when there is no clipboard (an insecure context), so the caller can show it instead. */
export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * A button that copies `value` and says so for a moment. Without a
 * clipboard it calls `onFail` (by default nothing: the text should already
 * be on screen to copy by hand).
 */
export function CopyButton({
  value,
  label,
  copied = 'Copied',
  className = ui.btn({ ghost: true, inline: true }),
  title,
  onFail,
  shareTarget,
  onCopied,
}: {
  value: string;
  label: ReactNode;
  copied?: ReactNode;
  className?: string;
  title?: string;
  onFail?: () => void;
  /** Counts a successful copy as a share of this kind (`share_copied`); a plain value, so Server Components can pass it. */
  shareTarget?: EventData['target'];
  /** Called after each successful copy. */
  onCopied?: () => void;
}) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={className}
      title={title}
      onClick={async () => {
        if (await copyText(value)) {
          setDone(true);
          if (shareTarget) track('share_copied', { target: shareTarget });
          onCopied?.();
          setTimeout(() => setDone(false), 1500);
        } else {
          onFail?.();
        }
      }}
    >
      {done ? copied : label}
    </button>
  );
}
