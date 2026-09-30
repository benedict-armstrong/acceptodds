'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ui } from '@/components/ui';
import { day } from '@/lib/format';

/** `GET /api/v1/me/affiliations`'s rows, as the API serves them. */
export interface AffiliationRow {
  id: string;
  email: string;
  institutionName: string;
  primary: boolean;
  verifiedAt: string | null;
  codeExpiresAt: string | null;
  createdAt: string;
}

const MESSAGES: Record<string, string> = {
  email_domain_not_allowed: 'That address is not at an approved institution.',
  already_affiliated: 'That address is already one of yours.',
  too_many_pending: 'Confirm or remove one of your unconfirmed addresses first.',
  affiliation_taken: 'Another account has confirmed that address.',
  primary_affiliation: 'The address you signed up with cannot be removed.',
  validation_error: 'That does not look like an email address.',
  rate_limited: 'Too many emails sent. Try again later.',
};

const CODE_MESSAGES: Record<string, string> = {
  wrong: 'That code is not right.',
  expired: 'That code has expired. Send a new one.',
  too_many_attempts: 'Too many wrong codes. Send a new one.',
  none: 'No code is outstanding for this address. Send a new one.',
};

async function errorText(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  const e = body?.error;
  if (e?.code === 'invalid_code') return CODE_MESSAGES[e.details?.reason] ?? 'That code did not work.';
  return MESSAGES[e?.code] ?? 'Something went wrong. Try again.';
}

/**
 * The viewer's institutional addresses as Table `n`, and a form to add one.
 * Each added address gets a 6-digit code by mail, typed in its row; only a
 * confirmed one shows on the profile. Writes go through `/api/v1/me/affiliations`.
 */
export function Affiliations({ initial, n }: { initial: AffiliationRow[]; n: number }) {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [email, setEmail] = useState('');
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  async function reload() {
    const res = await fetch('/api/v1/me/affiliations', { cache: 'no-store' });
    if (res.ok) setRows((await res.json()).affiliations);
    // The title block and trading eligibility are server-rendered.
    router.refresh();
  }

  /** Whether the call succeeded. */
  async function run(key: string, call: () => Promise<Response>, ok: string): Promise<boolean> {
    setBusy(key);
    setNote(null);
    try {
      const res = await call();
      if (!res.ok) {
        setNote({ ok: false, text: await errorText(res) });
        return false;
      }
      setNote({ ok: true, text: ok });
      await reload();
      return true;
    } catch {
      setNote({ ok: false, text: 'Could not reach the server. Try again.' });
      return false;
    } finally {
      setBusy(null);
    }
  }

  const post = (url: string, body: unknown) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  async function add(address: string, fromForm = false) {
    const sent = await run(
      `add:${address}`,
      () => post('/api/v1/me/affiliations', { email: address }),
      `Sent a code to ${address}. Enter it below within an hour.`,
    );
    if (sent && fromForm) setEmail('');
  }

  function confirm(row: AffiliationRow) {
    return run(
      `verify:${row.id}`,
      () => post(`/api/v1/me/affiliations/${row.id}/verify`, { code: (codes[row.id] ?? '').trim() }),
      `Confirmed: ${row.institutionName}.`,
    );
  }

  function remove(row: AffiliationRow) {
    return run(`remove:${row.id}`, () => fetch(`/api/v1/me/affiliations/${row.id}`, { method: 'DELETE' }), `Removed ${row.email}.`);
  }

  return (
    <div className="font-sans text-sm">
      <table className={ui.table}>
        <caption className={ui.tableCaption}>
          <b>Table {n}.</b> Your institutional addresses. Each confirmed one adds its institution to your name.
        </caption>
        <thead>
          <tr>
            <th className={ui.th()}>Address</th>
            <th className={`${ui.th()} narrow:hidden`}>Institution</th>
            <th className={ui.th()}>Status</th>
            <th className={ui.th()} />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="align-baseline">
              <td className={`${ui.td} ${ui.mono} break-all`}>{r.email}</td>
              <td className={`${ui.td} narrow:hidden`}>{r.institutionName}</td>
              <td className={ui.td}>
                {r.verifiedAt ? (
                  <span className="text-muted">
                    {r.primary ? 'signed up with' : `confirmed ${day(r.verifiedAt)}`}
                  </span>
                ) : (
                  <form
                    className="flex items-baseline gap-1.5"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void confirm(r);
                    }}
                  >
                    <input
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      pattern="\s*\d{6}\s*"
                      maxLength={8}
                      placeholder="6-digit code"
                      aria-label={`Code sent to ${r.email}`}
                      value={codes[r.id] ?? ''}
                      onChange={(e) => setCodes({ ...codes, [r.id]: e.target.value })}
                      className="w-[7.5em] border border-rule bg-white px-1.5 py-0.5 font-mono text-[13px]"
                    />
                    <button type="submit" className={ui.linkBtn} disabled={busy !== null}>
                      confirm
                    </button>
                    <button type="button" className={ui.linkBtn} disabled={busy !== null} onClick={() => void add(r.email)}>
                      resend
                    </button>
                  </form>
                )}
              </td>
              <td className={`${ui.td} text-right`}>
                {!r.primary && (
                  <button type="button" className={ui.linkBtn} disabled={busy !== null} onClick={() => void remove(r)}>
                    remove
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const address = email.trim();
          if (address) void add(address, true);
        }}
      >
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="another institutional address"
          aria-label="Add an institutional address"
          className="min-w-0 flex-1 border border-rule bg-white p-1.5 font-sans text-sm leading-[normal]"
        />
        <button type="submit" className={ui.btn({ ghost: true, inline: true, flush: true })} disabled={busy !== null}>
          add
        </button>
      </form>
      {note && <div className={ui.note(note.ok)}>{note.text}</div>}
    </div>
  );
}
