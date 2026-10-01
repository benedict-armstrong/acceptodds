'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { track } from '@/lib/track';
import { StarIcon } from './icons';

/**
 * Follow (star) a listing. Writes through the public API like every other
 * client (`PUT`/`DELETE /api/v1/listings/{id}/follow`), as the signed-in
 * viewer; the server checks the Origin. Only rendered for a signed-in viewer.
 */
export function FollowStar({
  listingId,
  following: initial,
  followers: initialFollowers,
  showCount = false,
  className = '',
}: {
  listingId: string;
  following: boolean;
  followers?: number;
  showCount?: boolean;
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
      {showCount && (
        <span className="ml-1 text-[13px] text-muted">
          {following ? 'following' : 'follow'}
          {followers > 0 ? ` ${followers}` : ''}
        </span>
      )}
    </button>
  );
}
