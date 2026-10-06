'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { groupPath } from '@/lib/links';
import { clearInvite, readInvite } from '@/lib/pending-invite';

/**
 * Joins the reading group whose invite a visitor accepted before they had
 * an account (`lib/pending-invite.ts`), as soon as they are signed in,
 * wherever sign-in or onboarding leaves them, then says so in a banner. A
 * dead invite is dropped quietly: the invite page says why if they go back.
 */
export function PendingGroupJoin({ signedIn }: { signedIn: boolean }) {
  const router = useRouter();
  const started = useRef(false);
  const [joined, setJoined] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    if (!signedIn || started.current) return;
    const code = readInvite();
    if (!code) return;
    started.current = true;
    void (async () => {
      try {
        const res = await fetch('/api/v1/groups/join', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ inviteCode: code }),
        });
        // A network failure keeps the invite for the next page; any answer ends it.
        clearInvite();
        if (!res.ok) return;
        const group = (await res.json()) as { id: string; name: string };
        setJoined({ id: group.id, name: group.name });
        router.refresh();
      } catch {
        started.current = false;
      }
    })();
  }, [signedIn, router]);

  if (!joined) return null;
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 border-b border-rule bg-highlight px-6 py-2 narrow:px-4 font-sans text-[13px]">
      <span>
        You joined the reading group <b>{joined.name}</b>.
      </span>
      <Link href={groupPath(joined.id)} className="font-semibold" onClick={() => setJoined(null)}>
        see its reading list
      </Link>
      <span className="flex-1" />
      <button className="cursor-pointer text-faint" onClick={() => setJoined(null)} aria-label="dismiss">
        ×
      </button>
    </div>
  );
}
