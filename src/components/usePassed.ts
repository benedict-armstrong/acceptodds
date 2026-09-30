'use client';

import { useEffect, useState } from 'react';

// setTimeout overflows past 2^31 − 1 ms (~24.8 days) and fires at once.
const MAX_DELAY = 2 ** 31 - 1;

/**
 * Whether the instant `atMs` has passed, flipping to true when it does. The
 * clock is read on mount and in a timer, never during render, which a
 * component must stay pure through.
 */
export function usePassed(atMs: number): boolean {
  const [passed, setPassed] = useState(() => Date.now() >= atMs);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const check = () => {
      const left = atMs - Date.now();
      setPassed(left <= 0);
      if (left > 0) timer = setTimeout(check, Math.min(left, MAX_DELAY));
    };
    timer = setTimeout(check, 0);
    return () => clearTimeout(timer);
  }, [atMs]);
  return passed;
}
