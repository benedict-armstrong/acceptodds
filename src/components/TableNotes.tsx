import type { ReactNode } from 'react';
import { ui } from './ui';

/**
 * A table's notes, directly under its bottom rule, as a paper's
 * threeparttable sets them: each keyed by the italic letter its column
 * heading carries (`<sup className={ui.mark}>a</sup>`). What a column means
 * goes here, not in a `title` tooltip, which a phone cannot show.
 */
export function TableNotes({ notes }: { notes: [mark: string, text: ReactNode][] }) {
  return (
    <div className="mt-1.5 space-y-0.5 font-serif text-xs leading-snug text-subtle">
      {notes.map(([mark, text]) => (
        <p key={mark}>
          <sup className={ui.mark}>{mark}</sup> {text}
        </p>
      ))}
    </div>
  );
}
