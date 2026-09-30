import type { ReactNode } from 'react';
import { TableNotes } from './TableNotes';
import { ui } from './ui';

/** A row: its label, its value, and optionally the letter of the note that explains it. */
export type DetailsRow = [label: string, value: ReactNode, mark?: string];

/**
 * Label–value rows as a booktabs table (portfolio, profile, public trader
 * page): no header, so only the top and bottom rules. `caption` follows
 * "Table N."; `notes` go under it, keyed by the rows' marks.
 */
export function DetailsTable({
  n,
  caption,
  rows,
  notes,
}: {
  n: number;
  caption: ReactNode;
  rows: DetailsRow[];
  notes?: [mark: string, text: ReactNode][];
}) {
  return (
    <>
      <table className={ui.table}>
        <caption className={ui.tableCaption}>
          <b>Table {n}.</b> {caption}
        </caption>
        <tbody>
          {rows.map(([label, value, mark]) => (
            <tr key={label}>
              <th scope="row" className={`${ui.td} text-left font-normal text-muted`}>
                {label}
                {mark && <sup className={ui.mark}>{mark}</sup>}
              </th>
              <td className={`${ui.td} text-right`}>{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {notes && notes.length > 0 && <TableNotes notes={notes} />}
    </>
  );
}
