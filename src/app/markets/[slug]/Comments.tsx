'use client';

import Link from 'next/link';
import { useState } from 'react';
import useSWR from 'swr';
import type { z } from 'zod';
import { ui } from '@/components/ui';
import { ago, shares } from '@/lib/format';
import type * as S from '@/server/api/schemas';

type CommentList = z.output<typeof S.CommentList>;

const fetchJson = (url: string) => fetch(url).then((r) => r.json());

/**
 * The discussion under a market. Anonymous: each comment shows its author's
 * current stake here (and a bot badge), nothing else. Only accounts that can
 * trade may post, so every voice has something on the line.
 */
export function Comments({
  marketId,
  initial,
  viewer,
}: {
  marketId: string;
  initial: CommentList;
  viewer: { signedIn: boolean; canTrade: boolean };
}) {
  const { data = initial, mutate } = useSWR<CommentList>(`/api/v1/markets/${marketId}/comments?limit=50`, fetchJson, {
    fallbackData: initial,
    refreshInterval: 10_000,
  });
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function post() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/v1/markets/${marketId}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    setBusy(false);
    if (res.ok) {
      setBody('');
      void mutate();
    } else {
      const e = await res.json().catch(() => null);
      setError(e?.error?.message ?? 'Could not post.');
    }
  }

  return (
    <section className="mt-9">
      <h3 className={ui.sectionHeading}>Discussion ({data.comments.length}{data.nextCursor ? '+' : ''})</h3>

      {viewer.canTrade ? (
        <div>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} placeholder="Add a comment"
            className="min-h-[70px] w-full border border-rule bg-white p-2 font-sans text-sm"
          />
          <div className="flex items-center justify-between gap-3">
            <span className={ui.fine}>Shown anonymously, with your position in this market.</span>
            <button className={ui.btn({ inline: true })} disabled={busy || body.trim().length === 0} onClick={post}>
              Post
            </button>
          </div>
          {error && <div className={ui.note(false)}>{error}</div>}
        </div>
      ) : (
        <div className={ui.fine}>
          {viewer.signedIn ? 'Only verified accounts can comment.' : <><Link href="/signin">Sign in</Link> to comment.</>}
        </div>
      )}

      {data.comments.map((c) => (
        <div key={c.id} className="border-b border-dotted border-rule-strong py-2.5">
          <div className="flex flex-wrap gap-2 font-sans text-xs text-muted">
            <span>{c.author.isYou ? 'you' : 'anonymous'}</span>
            {c.author.isBot && <span className={ui.badge}>bot</span>}
            {c.author.stake.length === 0 ? (
              <span>no position</span>
            ) : (
              c.author.stake.map((s) => (
                <span key={s.outcomeId} className="rounded-[2px] bg-tint px-[5px] font-mono text-xs text-ink">
                  {shares(s.sharesMicro)} {s.outcomeLabel}
                </span>
              ))
            )}
            <span suppressHydrationWarning>· {ago(c.createdAt)} ago</span>
          </div>
          <p className="mt-1 whitespace-pre-wrap">{c.body}</p>
        </div>
      ))}
    </section>
  );
}
