'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';
import { REP, signedPctOf, signedRep } from '@/lib/format';

const Absolute = createContext<[boolean, (v: boolean) => void]>([false, () => {}]);

/**
 * A P&L column shown as a percentage of its base by default, or in `REP`:
 * `PnlToggleProvider` holds the choice for a table, `PnlToggleHeading` is
 * the column heading that flips it, and each `Pnl` cell follows. For a
 * Server Component's table, whose rows stay server-rendered.
 */
export function PnlToggleProvider({ children }: { children: ReactNode }) {
  const state = useState(false);
  return <Absolute.Provider value={state}>{children}</Absolute.Provider>;
}

/** The heading, e.g. "Unrealized P/L (%)": a click switches the column between % and `REP`. */
export function PnlToggleHeading({ label }: { label: string }) {
  const [absolute, setAbsolute] = useContext(Absolute);
  return (
    <button
      className="cursor-pointer font-semibold hover:text-accent"
      aria-label={`${label}: show in ${absolute ? 'percent' : REP}`}
      onClick={() => setAbsolute(!absolute)}
    >
      {label} ({absolute ? REP : '%'})
    </button>
  );
}

/**
 * A P&L figure, as a percentage of `base` or in `REP`. `best` says in which
 * of the two it leads its column, and it is set in bold there.
 */
export function Pnl({
  micro,
  base,
  best = { absolute: false, percent: false },
}: {
  micro: bigint;
  base: bigint;
  best?: { absolute: boolean; percent: boolean };
}) {
  const [absolute] = useContext(Absolute);
  return (
    <span className={(absolute ? best.absolute : best.percent) ? 'font-bold' : ''}>
      {absolute ? signedRep(micro) : signedPctOf(micro, base)}
    </span>
  );
}
