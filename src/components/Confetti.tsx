'use client';

import confetti from 'canvas-confetti';
import { useEffect, useRef } from 'react';
import { TIER_HEX } from '@/lib/headline';

/** The accent and the outcome bar's tiers, so the burst is in the site's own colours. */
const COLORS = ['#b31b1b', ...TIER_HEX];
const DURATION_MS = 1500;

/**
 * Two bursts of confetti from the sides of the screen, once, when it is
 * mounted. Nothing at all for a viewer who asked for reduced motion. Renders
 * nothing itself: `canvas-confetti` draws on a canvas of its own over the page,
 * which ignores pointer events and is removed when the last piece lands.
 */
export function Confetti() {
  // Effects run twice in development's Strict Mode; one burst is the point.
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    const end = Date.now() + DURATION_MS;
    const shared = { particleCount: 3, spread: 55, colors: COLORS, disableForReducedMotion: true };
    const tick = () => {
      void confetti({ ...shared, angle: 60, origin: { x: 0, y: 0.7 } });
      void confetti({ ...shared, angle: 120, origin: { x: 1, y: 0.7 } });
      if (Date.now() < end) requestAnimationFrame(tick);
    };
    // Not cancelled on unmount: Strict Mode's cleanup would cut it to one frame, and it stops by itself.
    tick();
  }, []);
  return null;
}
