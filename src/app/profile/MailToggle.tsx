'use client';

import { useState, type ReactNode } from 'react';
import { ui } from '@/components/ui';

/** One of the optional mails, on or off, through `PATCH /api/v1/me`. */
export function MailToggle({
  field,
  optIn: initial,
  name,
  hint,
  children,
}: {
  field: 'digestOptIn' | 'mentionMailOptIn';
  optIn: boolean;
  /** For the saved note: "<name> on." */
  name: string;
  hint: string;
  children: ReactNode;
}) {
  const [optIn, setOptIn] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  async function change(next: boolean) {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch('/api/v1/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [field]: next }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      setOptIn(body[field]);
      setNote({ ok: true, text: `${name} ${body[field] ? 'on' : 'off'}.` });
    } catch {
      setNote({ ok: false, text: 'Could not save. Try again.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="font-sans text-sm">
      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          className="mt-[3px] accent-accent"
          checked={optIn}
          disabled={busy}
          onChange={(e) => change(e.target.checked)}
        />
        <span>
          {children}
          <span className="block text-xs text-muted">{hint}</span>
        </span>
      </label>
      {note && <div className={ui.note(note.ok)}>{note.text}</div>}
    </div>
  );
}
