import type { ReactNode } from 'react';

/**
 * One step of a guided flow, alone in the middle of the page: where it is in
 * the flow, one question as its heading, and the one thing to do. The flow
 * (`app/welcome`) decides the steps; this only sets them.
 */
export function OnboardingCard({
  step,
  of,
  title,
  onBack,
  children,
}: {
  /** 1-based; left out on a step outside the count (an introduction). */
  step?: number;
  of: number;
  title: ReactNode;
  /** Shown as "back" when there is a step to go back to. */
  onBack?: () => void;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-[480px] flex-col justify-center px-4 py-10">
      <div className="mb-3 flex items-baseline justify-between font-mono text-xs text-faint">
        <span>{step !== undefined && `${step} / ${of}`}</span>
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
