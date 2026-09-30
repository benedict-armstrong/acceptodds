import type { ReactNode } from 'react';
import { Abstract } from './Abstract';

/**
 * A page opened like a paper's first page: an optional line above the title
 * (the venue), the title, the author line, then anything the page adds
 * (`children`: links, actions), then the abstract. Papers, trader pages and
 * `/how-it-works` open with it.
 */
export function TitleBlock({
  above,
  title,
  byline,
  abstract,
  children,
}: {
  above?: ReactNode;
  title: ReactNode;
  byline?: ReactNode;
  abstract?: string | null;
  children?: ReactNode;
}) {
  return (
    <header className="mt-6 pb-3 text-center">
      {above && <div className="font-mono text-[13px] text-muted">{above}</div>}
      <h1 className="mt-2 mb-1.5 text-[30px] leading-tight font-normal narrow:text-2xl">{title}</h1>
      {byline && <div className="mx-auto max-w-[680px] text-[15px] text-subtle">{byline}</div>}
      {children}
      {abstract && <Abstract text={abstract} />}
    </header>
  );
}
