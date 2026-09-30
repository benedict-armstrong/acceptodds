/**
 * Small inline icons, drawn in `currentColor` so they take the text colour
 * of whatever they sit in. Decorative: the control carries the label.
 */

/** The "more" menu trigger: three dots, larger than the text `⋯`. */
export function MoreIcon({ className = 'size-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" className={className}>
      <circle cx="4" cy="10" r="1.75" />
      <circle cx="10" cy="10" r="1.75" />
      <circle cx="16" cy="10" r="1.75" />
    </svg>
  );
}

/** Share: an arrow leaving a tray. */
export function ShareIcon({ className = 'size-3.5' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M8 10V2M5 5l3-3 3 3" />
      <path d="M3 8v5.5h10V8" />
    </svg>
  );
}

/** Follow: a star, filled when following. `1em` square, so the text size sets it. */
export function StarIcon({ filled = false, className = 'size-[1em]' }: { filled?: boolean; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M8 1.5l1.9 4.1 4.5.5-3.4 3 1 4.4L8 11.3l-3.9 2.2 1-4.4-3.4-3 4.5-.5z" />
    </svg>
  );
}

/** Filter: a funnel. */
export function FilterIcon({ className = 'size-4' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M2 3h12l-4.5 5.5V13l-3 1.5v-6z" />
    </svg>
  );
}
