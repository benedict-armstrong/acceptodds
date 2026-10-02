'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { welcomeHref } from '@/lib/onboarding';
import { track } from '@/lib/track';
import { StarIcon } from './icons';

/**
 * Follow (star) a listing. Writes through the public API like every other
 * client (`PUT`/`DELETE /api/v1/listings/{id}/follow`), as the signed-in
 * viewer; the server checks the Origin. A visitor (`signUpNext` given) sees
 * the same star and count, linking to onboarding, which returns to `signUpNext`.
 */
export function FollowStar({
  listingId,
  following: initial,
  followers: initialFollowers,
  showCount = false,
  signUpNext,
  className = '',
}: {
  listingId: string;
  following: boolean;
  followers?: number;
  showCount?: boolean;
  /** For a visitor: the page to come back to after onboarding, instead of following. */
  signUpNext?: string;
  className?: string;
}) {
  const router = useRouter();
  const [following, setFollowing] = useState(initial);
  const [followers, setFollowers] = useState(initialFollowers ?? 0);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function toggle(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const res = await fetch(`/api/v1/listings/${listingId}/follow`, { method: following ? 'DELETE' : 'PUT' });
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      track('follow_toggled', { following: body.following });
      setFollowing(body.following);
      setFollowers(body.followers);
      router.refresh();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const label = following ? 'Unfollow this paper' : 'Follow this paper: get a morning email when its price moves';
  const count = showCount && followers > 0 && (
    <span className="ml-1 text-[13px] text-muted">{followers.toLocaleString('en-US')}</span>
  );

  if (signUpNext !== undefined) {
    return (
      <Link
        href={welcomeHref(signUpNext)}
        aria-label={label}
        title={label}
        className={`inline-flex items-center font-sans leading-none text-faint hover:text-ink hover:no-underline ${className}`}
      >
        <StarIcon filled={false} />
        {count}
      </Link>
    );
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      aria-pressed={following}
      aria-label={label}
      title={failed ? 'Could not update. Try again.' : label}
      className={`inline-flex cursor-pointer items-center font-sans leading-none disabled:cursor-default disabled:opacity-50 ${
        following ? 'text-accent' : failed ? 'text-down' : 'text-faint hover:text-ink'
      } ${className}`}
    >
      <StarIcon filled={following} />
      {count}
    </button>
  );
}
