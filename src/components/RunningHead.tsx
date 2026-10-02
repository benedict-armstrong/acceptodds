import type { ReactNode } from 'react';

/**
 * A paper's running head: one line at the top of the page, set left over a
 * full-width rule, as a conference template prints "Under review as …".
 */
export function RunningHead({ children }: { children: ReactNode }) {
  return <div className="border-b border-rule pb-0.5 font-serif text-[15px] text-subtle">{children}</div>;
}
