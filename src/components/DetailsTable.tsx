import type { ReactNode } from 'react';
import { ui } from './ui';

/**
 * Label–value rows as a booktabs table (profile, public trader page): no
 * header, so only the top and bottom rules. `caption` follows "Table N.".
 */
export function DetailsTable({ n, caption, rows }: { n: number; caption: ReactNode; rows: [string, ReactNode][] }) {
  return (
    <table className={ui.table}>
      <caption className={ui.tableCaption}>
        <b>Table {n}.</b> {caption}
      </caption>
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label}>
            <th scope="row" className={`${ui.td} text-left font-normal text-muted`}>
              {label}
            </th>
            <td className={`${ui.td} text-right`}>{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
