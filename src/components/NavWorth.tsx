'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { MiniCurve } from './MiniCurve';
import { ui } from './ui';

export type NavWorthMode = 'rep' | 'percentile';

/** Where the viewer sits, for the navbar: see `MiniCurve`. */
export interface NavStanding {
  /** The field's density, sampled evenly, peaking at 1. */
  curve: number[];
  /** The viewer's position across it, 0 to 1. */
  at: number;
  /** "ahead of 96% of traders", for the title and screen readers. */
  label: string;
}

/**
 * The navbar's figure: net worth at liquidation value, or, after a click,
 * where that puts the viewer on the net-worth leaderboard (#17): a tiny
 * bell curve of the field with a line at the viewer (`MiniCurve`), the
 * percentile in its title and label. Each click flips it. The choice is a
 * cookie the layout reads, so the page renders it with no flash, and only a
 * viewer who asked for the percentile pays for valuing the field. A
 * preference, nothing more: no account, no API.
 */
export function NavWorth({
  cookie,
  mode,
  worth,
  standing,
  title,
}: {
  /** The cookie the layout reads the choice from. */
  cookie: string;
  mode: NavWorthMode;
  /** "1,234.00 $rep". */
  worth: string;
  /** `null` until the server has rendered it. */
  standing: NavStanding | null;
  title: string;
}) {
  const router = useRouter();
  const [shown, setShown] = useState(mode);
  const [pending, startTransition] = useTransition();
  const flip = () => {
    const next: NavWorthMode = shown === 'rep' ? 'percentile' : 'rep';
    setShown(next);
    document.cookie = `${cookie}=${next}; path=/; max-age=31536000; samesite=lax`;
    // The percentile is computed on the server; fetch it if this render lacks it.
    if (next === 'percentile' && standing === null) startTransition(() => router.refresh());
  };
  return (
    <button
      type="button"
      onClick={flip}
      title={`${shown === 'percentile' && standing ? `You: ${standing.label}. ` : ''}${title} · click to show ${shown === 'rep' ? 'where you stand' : 'your net worth'}`}
      aria-label={shown === 'percentile' ? (standing ? `You are ${standing.label}` : 'Loading where you stand') : undefined}
      className={`${ui.mono} cursor-pointer hover:text-accent`}
    >
      {shown === 'rep' ? worth : standing ? <MiniCurve curve={standing.curve} at={standing.at} /> : pending ? '…' : '—'}
    </button>
  );
}
