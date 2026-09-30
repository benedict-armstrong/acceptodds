import { REP, rep, signedRep } from '@/lib/format';
import { ui } from './ui';

/** A reputation figure in a table cell (profile, public trader page); `signed` for P&L, coloured. */
export function Amount({ micro, signed = false }: { micro: string | bigint; signed?: boolean }) {
  return (
    <span className={`font-mono text-[13px] ${signed ? ui.pnl(micro) : 'text-ink'}`}>
      {signed ? signedRep(micro) : rep(micro)} {REP}
    </span>
  );
}
