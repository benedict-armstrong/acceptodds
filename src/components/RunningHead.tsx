import type { ReactNode } from 'react';

/**
 * A paper's running head: one line at the top of the page, set left over a
 * full-width rule, as a paper's template prints one. The words are the
 * venue's (`venues/` `runningHead`).
 */
export function RunningHead({ children }: { children: ReactNode }) {
  return <div className="border-b border-rule pb-0.5 font-serif text-[15px] text-subtle">{children}</div>;
}
