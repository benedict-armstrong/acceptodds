'use client';

import { useState } from 'react';
import { ui } from '@/components/ui';

/** The daily followed-papers email, on or off, through `PATCH /api/v1/me`. */
export function DigestToggle({ optIn: initial, minMovePp }: { optIn: boolean; minMovePp: number }) {
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
        body: JSON.stringify({ digestOptIn: next }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      setOptIn(body.digestOptIn);
      setNote({ ok: true, text: body.digestOptIn ? 'Morning emails on.' : 'Morning emails off.' });
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
          Email me each morning when a paper I follow has moved by {minMovePp} percentage points or more over the last day.
          <span className="block text-xs text-muted">One email a day at most, only when something moved.</span>
        </span>
      </label>
      {note && <div className={ui.note(note.ok)}>{note.text}</div>}
    </div>
  );
}
