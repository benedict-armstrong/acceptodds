import { profileShareText, type ProfileShareInput } from '@/lib/profile-share';
import { siteName, siteUrl } from '@/server/share';
import { CopyButton } from './CopyButton';
import { ShareIcon } from './icons';
import { ui } from './ui';

/**
 * "share" on a trader's page and on `/profile`: copies who they are, their
 * place on the net-worth board with an ASCII bar, and the link to
 * `/people/<handle>`, whose preview image draws the field with them on it.
 * Only what that public page already shows.
 */
export function ShareProfile({
  account,
  standing,
}: {
  account: { displayName: string; handle: string };
  standing: ProfileShareInput['standing'];
}) {
  const text = profileShareText({
    displayName: account.displayName,
    handle: account.handle,
    site: siteName(),
    url: `${siteUrl()}/people/${encodeURIComponent(account.handle)}`,
    standing,
  });
  return (
    <CopyButton
      value={text}
      label={
        <span className="inline-flex items-center gap-1">
          <ShareIcon />
          share
        </span>
      }
      copied="copied"
      className={ui.linkBtn}
      title="Copy where this trader stands, with the link"
    />
  );
}
