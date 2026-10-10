'use client';

import Link from 'next/link';
import type { ComponentProps } from 'react';

/** How long the scroll takes: slow enough to see the page go by, so the reader knows where they went. */
const DURATION_MS = 900;

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * Scrolls `target` into place slowly, eased: its top at the top of the
 * window, less its `scroll-margin-top`, or with `at` the top of `part` (a
 * selector inside it, else the target) that fraction of the way down the
 * window. Instant under reduced motion.
 */
function scrollSlowly(target: HTMLElement, part?: string, at?: number) {
  const from = window.scrollY;
  const placed = (part && target.querySelector(part)) || target;
  const top = placed.getBoundingClientRect().top;
  const offset = at === undefined ? parseFloat(getComputedStyle(target).scrollMarginTop) || 0 : window.innerHeight * at;
  const distance = Math.max(-from, top - offset);
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    window.scrollTo(0, from + distance);
    return;
  }
  const start = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / DURATION_MS);
    window.scrollTo(0, from + distance * easeInOutCubic(t));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/**
 * A link to an element on the same page (`#id`) that scrolls there slowly,
 * eased, rather than jumping. By default the target's top lands at the top of
 * the window, less its `scroll-margin-top`; with `at`, the top of `part` (a
 * selector inside the target, else the target) lands that fraction of the way
 * down the window. Instant under reduced motion. The hash is set as a plain link would, without
 * a jump; without JS it is that plain link.
 */
export function ScrollLink({
  to,
  part,
  at,
  className,
  children,
}: {
  /** The target's id, without `#`. */
  to: string;
  /** A selector, inside the target, for the element `at` places. */
  part?: string;
  /** How far down the window the element's top lands, 0–1. */
  at?: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={`#${to}`}
      className={className}
      onClick={(e) => {
        const target = document.getElementById(to);
        if (!target) return;
        e.preventDefault();
        history.replaceState(null, '', `#${to}`);
        scrollSlowly(target, part, at);
      }}
    >
      {children}
    </a>
  );
}

/**
 * A link to another page that first scrolls this one slowly to `to` (an id),
 * its top `at` of the way down the window, and keeps that scroll when the
 * new page arrives (`scroll={false}`) rather than jumping to the top. For a
 * link that changes what is under the target and not above it: the home
 * page's sorts, landing on "All papers". Without JS, or without the target,
 * it is that plain link.
 */
export function ScrollingLink({
  to,
  at,
  onClick,
  ...props
}: Omit<ComponentProps<typeof Link>, 'scroll'> & { to: string; at?: number }) {
  return (
    <Link
      {...props}
      scroll={false}
      onClick={(e) => {
        const target = document.getElementById(to);
        if (target) scrollSlowly(target, undefined, at);
        onClick?.(e);
      }}
    />
  );
}
