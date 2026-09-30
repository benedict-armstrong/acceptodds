'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { CopyButton } from '@/components/CopyButton';
import { Modal, ModalContent, ModalTrigger } from '@/components/Modal';
import { ui } from '@/components/ui';
import { publicPositionPath } from '@/lib/links';

/**
 * Makes one of the viewer's positions public or private again (#36), through
 * `PUT`/`DELETE /api/v1/me/positions/{outcomeId}/public`. Resolves to the
 * link id while public, null once private; throws on failure.
 */
async function setPublic(outcomeId: string, on: boolean): Promise<string | null> {
  const res = await fetch(`/api/v1/me/positions/${outcomeId}/public`, { method: on ? 'PUT' : 'DELETE' });
  if (!res.ok) throw new Error(String(res.status));
  return (await res.json()).publicPositionId;
}

/**
 * A holding's Share button. A private position opens on what making it public
 * shows, and the warning that matters: comments show their author's stake,
 * so a public, named position of the same size tells readers which comments
 * on that market are yours. A public one opens on its link, to copy, and a
 * way to make it private again.
 */
export function SharePositionModal({
  outcomeId,
  outcomeLabel,
  publicPositionId,
}: {
  outcomeId: string;
  outcomeLabel: string;
  publicPositionId: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // What this modal last set, until the polled holding catches up.
  const [override, setOverride] = useState<{ id: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const id = override ? override.id : publicPositionId;

  async function change(on: boolean) {
    setBusy(true);
    setFailed(false);
    try {
      setOverride({ id: await setPublic(outcomeId, on) });
      router.refresh();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const url = id && typeof window !== 'undefined' ? new URL(publicPositionPath(id), window.location.origin).href : '';
  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        setFailed(false);
      }}
    >
      <ModalTrigger
        className={`${ui.btn({ ghost: true, inline: true, flush: true })} ml-1`}
        title={id ? 'This position is public' : 'Share this position'}
      >
        {id ? 'Public' : 'Share'}
      </ModalTrigger>
      <ModalContent title={id ? `Your ${outcomeLabel} position is public` : `Share your ${outcomeLabel} position`}>
        {id ? (
          <>
            <p className="mb-2">
              Anyone with the link sees it, under your name, and it is listed on your public page. It follows the
              position as you trade.
            </p>
            <input className={`${ui.input} font-mono`} readOnly value={url} onFocus={(e) => e.target.select()} />
            <div className="flex items-center gap-3">
              <CopyButton value={url} label="Copy link" className={ui.btn({ inline: true, flush: true })} />
              <Link href={publicPositionPath(id)}>open →</Link>
              <button className={`${ui.linkBtn} ml-auto`} disabled={busy} onClick={() => change(false)}>
                Make private
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="mb-2">
              Making it public gives it a link to share and lists it on your public page, under your name: the
              outcome, your shares, what they cost and how the position stands, kept up to date as you trade.
            </p>
            <p className="mb-2">
              <b>It links you to your comments on this market.</b> A comment shows its author’s stake, so anyone who
              compares the two can tell which comments are yours. Your positions and comments elsewhere stay
              private.
            </p>
            <p className="mb-1 text-muted">You can make it private again at any time; the link then stops working.</p>
            <button className={ui.btn()} disabled={busy} onClick={() => change(true)}>
              Make public
            </button>
          </>
        )}
        {failed && <div className={ui.note(false)}>Could not update. Try again.</div>}
      </ModalContent>
    </Modal>
  );
}

/** On the owner's own public position page: make it private, then go to their public page. */
export function MakePrivateButton({ outcomeId, handle }: { outcomeId: string; handle: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <>
      <button
        className={ui.linkBtn}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setFailed(false);
          try {
            await setPublic(outcomeId, false);
            router.push(`/people/${encodeURIComponent(handle)}`);
          } catch {
            setFailed(true);
            setBusy(false);
          }
        }}
      >
        make it private
      </button>
      {failed && <span className="ml-2 text-down">Could not update. Try again.</span>}
    </>
  );
}
