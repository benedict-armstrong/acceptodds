'use client';

import Link from 'next/link';
import { PopoverClose } from './Popover';

/** Navigation inside the shared account popover on narrow screens. */
export function MobileNav() {
  const links = [
    ['/profile', 'profile'],
    ['/portfolio', 'portfolio'],
    ['/map', 'map'],
    ['/leaderboard', 'leaderboard'],
  ];

  return (
    <div className="hidden narrow:block">
      <hr className="my-1 border-rule" />
      <nav aria-label="Mobile navigation" className="flex flex-col font-serif text-lg">
        {links.map(([href, label]) => (
          <PopoverClose key={href} asChild>
            <Link
              href={href}
              className="flex min-h-11 items-center px-1 py-1.5 hover:underline focus-visible:underline"
            >
              {label}
            </Link>
          </PopoverClose>
        ))}
      </nav>
    </div>
  );
}
