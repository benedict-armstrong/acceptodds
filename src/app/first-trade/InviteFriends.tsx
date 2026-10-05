'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CopyButton } from '@/components/CopyButton';
import { CopyField } from '@/components/CopyField';
import { NewGroupButton } from '@/components/Groups';
import { ShareButton } from '@/components/ShareButtons';
import { ui } from '@/components/ui';
import { siteShareLinks } from '@/lib/invite';
import { groupInvitePath } from '@/lib/links';

interface MyGroup {
  id: string;
  name: string;
  inviteCode: string;
}

/**
 * The first-trade page's ask: bring someone along, by sharing the market
 * just traded (`url`, its BibTeX entry as `citation`) or by inviting them to
 * a group, then go on (`next`). It shares nothing by itself, and never the
 * trader's position (§1.1, #36). The way on is a quiet ghost button until
 * something has been copied or shared, so the ask is what the eye lands on.
 */
export function InviteFriends({
  siteName,
  url,
  citation,
  venue,
  next,
}: {
  siteName: string;
  url: string;
  citation: string;
  venue: string;
  next: { href: string; label: string };
}) {
  const [groups, setGroups] = useState<MyGroup[]>([]);
  const [shared, setShared] = useState(false);
  const onShared = () => setShared(true);

  // Groups the viewer is already in, to invite to.
  useEffect(() => {
    fetch('/api/v1/me/groups')
      .then((r) => (r.ok ? r.json() : { groups: [] }))
      .then((b) => setGroups(b.groups))
      .catch(() => {});
  }, []);

  const links = siteShareLinks({ name: siteName, venue, url });

  return (
    <>
      <p className="mb-3 text-muted">Share with a friend:</p>
      <CopyField multiline value={citation} label="BibTeX entry for this market" className="mb-2" onCopied={onShared} />
      <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
        <ShareButton service="x" href={links.x} onShared={onShared} />
        <ShareButton service="whatsapp" href={links.whatsapp} onShared={onShared} />
      </div>
      <div className="mb-1 text-muted">Or invite them to a reading group, a shared reading list and leaderboard:</div>
      <ul className="mb-2">
        {groups.map((g) => (
          <li key={g.id} className="flex items-baseline justify-between gap-3 py-0.5">
            <span>{g.name}</span>
            <CopyButton
              value={new URL(groupInvitePath(g.inviteCode), url).href}
              label="Copy invite link"
              className={ui.linkBtn}
              onCopied={onShared}
            />
          </li>
        ))}
      </ul>
      <NewGroupButton />
      <div className="mt-4">
        <Link href={next.href} className={ui.btn({ ghost: !shared })}>
          {next.label}
        </Link>
      </div>
    </>
  );
}
