import type { ReactNode } from 'react';

/**
 * One step of a guided flow, alone in the middle of the page: one question
 * as its heading, and the one thing to do. No step count: the flow is short,
 * and its length depends on where the person came in. The flow
 * (`app/welcome`) decides the steps; this only sets them.
 */
export function OnboardingCard({
  title,
  onBack,
  children,
}: {
  title: ReactNode;
  /** Shown as "back" when there is a step to go back to. */
  onBack?: () => void;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-[480px] flex-col justify-center px-4 py-10">
      <div className="mb-3 flex min-h-4 items-baseline justify-end font-mono text-xs text-faint">
        {onBack && (
          <button type="button" className="cursor-pointer hover:text-ink" onClick={onBack}>
            back
          </button>
        )}
      </div>
      <h1 className="mb-4 text-[26px] leading-tight font-normal narrow:text-[22px]">{title}</h1>
      {children}
    </main>
  );
}
