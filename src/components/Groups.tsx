'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent, type ReactNode } from 'react';
import { CopyButton } from '@/components/CopyButton';
import { Modal, ModalClose, ModalContent, ModalTrigger } from '@/components/Modal';
import { ui } from '@/components/ui';
import { groupInvitePath, groupPath } from '@/lib/links';

/**
 * Leaderboard groups in the UI (#25): making one, joining by invite link,
 * and a group board's actions. Everything writes through `/api/v1/groups`,
 * as every other client does; the page then re-reads (`router.refresh`).
 */

/** Calls the groups API as the viewer; the parsed body, or throws the API's message. */
async function call(method: string, path: string, body?: unknown): Promise<{ id?: string } | null> {
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error?.message ?? 'Something went wrong. Try again.');
  return json;
}

/** Runs one write at a time, keeping its error to show. */
function useWrite() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(write: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await write();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run, reset: () => setError(null) };
}

/** A group's name and description, for making or editing one. */
function GroupForm({
  initial,
  submit,
  onSubmit,
}: {
  initial: { name: string; description: string | null };
  submit: string;
  onSubmit: (v: { name: string; description: string | null }) => Promise<void>;
}) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description ?? '');
  const { busy, error, run } = useWrite();
  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        run(() => onSubmit({ name, description: description.trim() || null }));
      }}
    >
      <label className="mb-1 block text-muted" htmlFor="group-name">
        Name
      </label>
      <input
        id="group-name"
        className={ui.input}
        value={name}
        maxLength={80}
        required
        autoFocus
        onChange={(e) => setName(e.target.value)}
      />
      <label className="mb-1 block text-muted" htmlFor="group-description">
        Description <span className="text-faint">(optional, shown as its abstract)</span>
      </label>
      <textarea
        id="group-description"
        className={`${ui.input} min-h-20`}
        value={description}
        maxLength={500}
        onChange={(e) => setDescription(e.target.value)}
      />
      <button type="submit" className={ui.btn()} disabled={busy || name.trim() === ''}>
        {submit}
      </button>
      {error && <div className={ui.note(false)}>{error}</div>}
    </form>
  );
}

/** "New group": makes one with the viewer as admin, then opens its board. */
export function NewGroupButton({ className = ui.linkBtn }: { className?: string }) {
  const router = useRouter();
  // Controlled: the new board is the same page with another `?group=`, so nothing unmounts the modal for us.
  const [open, setOpen] = useState(false);
  return (
    <Modal open={open} onOpenChange={setOpen}>
      <ModalTrigger className={className}>+ Create a group</ModalTrigger>
      <ModalContent title="New group">
        <p className="mb-3 text-muted">
          A leaderboard of its own: you and whoever joins with its invite link, ranked among yourselves. You can rename
          it, remove members or delete it later.
        </p>
        <GroupForm
          initial={{ name: '', description: null }}
          submit="Make group"
          onSubmit={async (v) => {
            const group = await call('POST', '/groups', v);
            setOpen(false);
            router.push(groupPath(group!.id!));
          }}
        />
      </ModalContent>
    </Modal>
  );
}

/** On an invite page: join, then open the group's board. */
export function JoinGroupButton({ code, groupId }: { code: string; groupId: string }) {
  const router = useRouter();
  const { busy, error, run } = useWrite();
  return (
    <>
      <button
        className={ui.btn({ inline: true })}
        disabled={busy}
        onClick={() =>
          run(async () => {
            await call('POST', '/groups/join', { inviteCode: code });
            router.push(groupPath(groupId));
          })
        }
      >
        Join the group
      </button>
      {error && <div className={ui.note(false)}>{error}</div>}
    </>
  );
}

export interface GroupActionsProps {
  group: { id: string; name: string; description: string | null; inviteCode: string };
  role: 'admin' | 'member';
  viewerHandle: string;
  members: { handle: string; displayName: string; role: 'admin' | 'member' }[];
}

/** A confirming modal behind a link-like button: `action` runs on "yes". */
function Confirm({
  trigger,
  title,
  children,
  yes,
  action,
}: {
  trigger: string;
  title: string;
  children: ReactNode;
  yes: string;
  action: () => Promise<void>;
}) {
  const { busy, error, run, reset } = useWrite();
  return (
    <Modal onOpenChange={reset}>
      <ModalTrigger className={ui.linkBtn}>{trigger}</ModalTrigger>
      <ModalContent title={title}>
        <div className="mb-2">{children}</div>
        <div className="flex gap-2">
          <button className={ui.btn({ inline: true })} disabled={busy} onClick={() => run(action)}>
            {yes}
          </button>
          <ModalClose className={ui.btn({ ghost: true, inline: true })}>Cancel</ModalClose>
        </div>
        {error && <div className={ui.note(false)}>{error}</div>}
      </ModalContent>
    </Modal>
  );
}

/**
 * Under a group board's title: the invite link for every member, "leave"
 * for a member, and for the admin edit, members (remove, new invite link)
 * and delete.
 */
export function GroupActions({ group, role, viewerHandle, members }: GroupActionsProps) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const { busy, error, run } = useWrite();
  const invite =
    typeof window === 'undefined'
      ? groupInvitePath(group.inviteCode)
      : new URL(groupInvitePath(group.inviteCode), window.location.origin).href;
  const base = `/groups/${group.id}`;

  return (
    <div className="mt-3 flex flex-wrap items-baseline justify-center gap-x-4 gap-y-1 font-sans text-[13px]">
      <CopyButton value={invite} label="Copy invite link" className={ui.linkBtn} />
      {role === 'member' && (
        <Confirm
          trigger="Leave"
          title={`Leave ${group.name}?`}
          yes="Leave"
          action={async () => {
            await call('DELETE', `${base}/members/${encodeURIComponent(viewerHandle)}`);
            router.push('/leaderboard');
          }}
        >
          You can join again with its invite link.
        </Confirm>
      )}
      {role === 'admin' && (
        <>
          <Modal open={editing} onOpenChange={setEditing}>
            <ModalTrigger className={ui.linkBtn}>Edit</ModalTrigger>
            <ModalContent title="Edit group">
              <GroupForm
                initial={group}
                submit="Save"
                onSubmit={async (v) => {
                  await call('PATCH', base, v);
                  setEditing(false);
                  router.refresh();
                }}
              />
            </ModalContent>
          </Modal>
          <Modal>
            <ModalTrigger className={ui.linkBtn}>Members</ModalTrigger>
            <ModalContent title={`Members of ${group.name}`}>
              <ul className="mb-3 max-h-72 overflow-y-auto">
                {members.map((m) => (
                  <li key={m.handle} className="flex items-baseline justify-between gap-3 py-0.5">
                    <span>
                      {m.displayName} <span className="text-muted">@{m.handle}</span>
                    </span>
                    {m.role === 'admin' ? (
                      <span className="text-muted">admin</span>
                    ) : (
                      <button
                        className={ui.linkBtn}
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            await call('DELETE', `${base}/members/${encodeURIComponent(m.handle)}`);
                            router.refresh();
                          })
                        }
                      >
                        remove
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              <p className="mb-1 text-muted">
                A new invite link stops the old one working. Nobody already in the group is removed.
              </p>
              <button
                className={ui.btn({ ghost: true, inline: true })}
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await call('POST', `${base}/invite`);
                    router.refresh();
                  })
                }
              >
                New invite link
              </button>
              {error && <div className={ui.note(false)}>{error}</div>}
            </ModalContent>
          </Modal>
          <Confirm
            trigger="Delete"
            title={`Delete ${group.name}?`}
            yes="Delete group"
            action={async () => {
              await call('DELETE', base);
              router.push('/leaderboard');
            }}
          >
            The group and its board go for everyone in it. Nobody’s reputation or positions change.
          </Confirm>
        </>
      )}
    </div>
  );
}
