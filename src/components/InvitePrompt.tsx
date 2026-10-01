'use client';

import { useEffect, useState } from 'react';
import { CopyButton } from '@/components/CopyButton';
import { CopyField } from '@/components/CopyField';
import { NewGroupButton } from '@/components/Groups';
import { Modal, ModalClose, ModalContent } from '@/components/Modal';
import { FIRST_TRADE_EVENT } from '@/components/orders';
import { ui } from '@/components/ui';
import { siteCitation } from '@/lib/invite';
import { groupInvitePath } from '@/lib/links';

interface MyGroup {
  id: string;
  name: string;
  inviteCode: string;
}

/**
 * After an account's first trade (`Fill.firstTrade`, announced by `useOrder`):
 * a one-time dialog asking whether to bring someone along, by sharing the site
 * or by inviting them to a group. Mounted once in the layout so it survives
 * the navigation a bet placed from onboarding ends with. It asks for nothing
 * and shares nothing by itself: the link is the site's, never the trader's
 * position (§1.1, #36).
 */
export function InvitePrompt({ siteName }: { siteName: string }) {
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<MyGroup[]>([]);

  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(FIRST_TRADE_EVENT, show);
    return () => window.removeEventListener(FIRST_TRADE_EVENT, show);
  }, []);

  // Groups the viewer is already in, to invite to; read when the dialog opens.
  useEffect(() => {
    if (!open) return;
    fetch('/api/v1/me/groups')
      .then((r) => (r.ok ? r.json() : { groups: [] }))
      .then((b) => setGroups(b.groups))
      .catch(() => { });
  }, [open]);

  const origin = typeof window === 'undefined' ? '' : window.location.origin;

  return (
    <Modal open={open} onOpenChange={setOpen}>
      <ModalContent title="Congratulations on four first trade!" wide>
        <p className="mb-3 text-muted">
          acceptodds is better the more people trade.
          <br />
          Send this link to a friend:
        </p>
        <CopyField
          multiline
          value={siteCitation({ name: siteName, url: origin, year: new Date().getFullYear() })}
          label={`BibTeX entry for ${siteName}`}
          className="mb-3"
        />
        <div className="mb-1 text-muted">Or invite them to a group, a leaderboard of your own:</div>
        <ul className="mb-2">
          {groups.map((g) => (
            <li key={g.id} className="flex items-baseline justify-between gap-3 py-0.5">
              <span>{g.name}</span>
              <CopyButton
                value={new URL(groupInvitePath(g.inviteCode), origin).href}
                label="Copy invite link"
                className={ui.linkBtn}
              />
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          {/* Making a group moves to its board: the dialog has done its job. */}
          <NewGroupButton onCreated={() => setOpen(false)} />
          {/* <ModalClose className={ui.linkBtn}>Not now</ModalClose> */}
        </div>
      </ModalContent>
    </Modal>
  );
}
