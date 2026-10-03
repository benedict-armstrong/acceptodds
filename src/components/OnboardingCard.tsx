import type { ReactNode } from 'react';

/**
 * One step of a guided flow, alone in the middle of the page: one question
 * as its heading, and the one thing to do. No step count: the flow is short,
 * and its length depends on where the person came in. The flow
 * (`app/welcome`) decides the steps; this only sets them.
 */
export function OnboardingCard({
  title,
  eyebrow,
  onBack,
  children,
}: {
  title: ReactNode;
  /** A small, light line above the question, naming the flow it belongs to. */
  eyebrow?: ReactNode;
  /** Shown as "back" when there is a step to go back to. */
  onBack?: () => void;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-[480px] flex-col justify-center px-4 py-10">
      {/* Above the question, where it starts: the way back is the first
          thing on the left, as in any step-by-step flow. The row is kept
          without it, so the question does not jump between steps. */}
      <div className="mb-2 min-h-5">
        {onBack && (
          <button
            type="button"
            className="-ml-1 cursor-pointer px-1 font-sans text-sm text-muted hover:text-ink"
            onClick={onBack}
          >
            ← Back
          </button>
        )}
      </div>
      {eyebrow && <div className="mb-1 font-sans text-sm text-muted">{eyebrow}</div>}
      <h1 className="mb-4 text-[26px] leading-tight font-normal narrow:text-[22px]">{title}</h1>
      {children}
    </main>
  );
}
