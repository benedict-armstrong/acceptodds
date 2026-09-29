'use client';

/**
 * A `<details>` that remembers whether it was left open, in a cookie the
 * server reads (`cookies().get(cookie)`), so the page renders it that way
 * with no flash. A preference, nothing more: no account, no API.
 */
export function Collapsible({
  cookie,
  open,
  summary,
  className = '',
  id,
  children,
}: {
  cookie: string;
  open: boolean;
  summary: React.ReactNode;
  className?: string;
  id?: string;
  children: React.ReactNode;
}) {
  return (
    <details
      id={id}
      open={open}
      className={className}
      onToggle={(e) => {
        const v = (e.currentTarget as HTMLDetailsElement).open ? '1' : '0';
        document.cookie = `${cookie}=${v}; path=/; max-age=31536000; samesite=lax`;
      }}
    >
      {summary}
      {children}
    </details>
  );
}
