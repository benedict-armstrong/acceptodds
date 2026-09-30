import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Account } from '@/db/schema';
import { day } from '@/lib/format';
import { ui } from './ui';

/**
 * A trader's name set like a paper's title block: the name as the title,
 * then an author line (`@handle, Institution; Institution`, one per confirmed
 * affiliation, as a paper lists them) and a one-paragraph
 * abstract of who they are, spaced like a paper's first page. `/profile` and `/people/<handle>` both open with
 * it; only the profile passes `email` and `admin`, which are not public.
 * `children` go between the author line and the abstract.
 */
export function TraderHeader({
  account: a,
  email,
  admin = false,
  children,
}: {
  account: Pick<Account, 'displayName' | 'handle' | 'isBot' | 'institutions' | 'createdAt' | 'verifiedAt'>;
  email?: string;
  admin?: boolean;
  children?: ReactNode;
}) {
  return (
    <header className="mt-8 pb-5 text-center">
      <h1 className="mb-4 text-[30px] leading-tight font-normal">
        {a.displayName}
        {a.isBot && <span className={ui.badge}>bot</span>}
      </h1>
      <div className="text-[15px] text-subtle">
        @{a.handle}
        {a.institutions.map((name, i) => (
          <span key={name}>
            {i === 0 ? ', ' : '; '}
            <Link href={`/leaderboard?institution=${encodeURIComponent(name)}`}>
              <i>{name}</i>
            </Link>
          </span>
        ))}
      </div>
      {email && <div className="mt-1 font-mono text-[13px] text-subtle">{email}</div>}
      {children}
      {/* Inset from the text width, as a paper's abstract is. */}
      <p className="mx-auto mt-7 max-w-[460px] text-left text-[14px] leading-[1.55]">{abstract(a, admin)}</p>
    </header>
  );
}

/** Who the trader is, in a sentence or two, from the account row alone. */
function abstract(a: Parameters<typeof TraderHeader>[0]['account'], admin: boolean): string {
  const at = a.institutions.length ? ` at ${andList(a.institutions)}` : '';
  const parts = [
    a.isBot
      ? `${a.displayName} is a bot, trading since ${day(a.createdAt)}.`
      : `${a.displayName} is a trader${at}, here since ${day(a.createdAt)}.`,
  ];
  // Bots trade without verification, so it says nothing about them.
  if (!a.isBot) {
    parts.push(
      a.verifiedAt
        ? `Verified by institutional email on ${day(a.verifiedAt)}.`
        : 'Not yet verified, so may browse the markets but not trade.',
    );
  }
  if (admin) parts.push('Also an administrator, who can create, close and settle markets.');
  return parts.join(' ');
}

/** "A", "A and B", "A, B and C". */
function andList(items: readonly string[]): string {
  return items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
