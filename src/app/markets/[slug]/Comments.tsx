'use client';

import { useEffect, useState } from 'react';
import useSWR from 'swr';
import type { z } from 'zod';
import { SignInLink } from '@/components/AuthLinks';
import { Markdown } from '@/components/Markdown';
import { OutcomeSwatch } from '@/components/OutcomeBar';
import { ui } from '@/components/ui';
import { ago, rep, REP, shares } from '@/lib/format';
import { parseUnits } from '@/lib/money';
import type * as S from '@/server/api/schemas';

type CommentList = z.output<typeof S.CommentList>;
type Comment = z.output<typeof S.Comment>;
type Sort = (typeof S.COMMENT_SORTS)[number];
type Available = { outcomeId: string; outcomeLabel: string; freeMicro: bigint };

const fetchJson = (url: string) => fetch(url).then((r) => r.json());

const MESSAGES: Record<string, string> = {
  insufficient_stake: 'You don’t have that many unallocated shares of this outcome.',
  own_comment: 'You can’t back your own comment.',
  not_verified: 'Only verified accounts can back comments.',
  market_closed: 'This market has closed.',
  market_not_open: 'This market is not open.',
  rate_limited: 'Too many requests. Wait a moment.',
};

async function errorText(res: Response, fallback: string): Promise<string> {
  const e = await res.json().catch(() => null);
  return MESSAGES[e?.error?.code] ?? e?.error?.message ?? fallback;
}

/**
 * The discussion under a market. Anonymous: each comment shows its author's
 * current stake here (and a bot badge), nothing else. Only accounts that can
 * trade may post, so every voice has something on the line.
 *
 * Traders can put shares they hold behind other people's comments. The
 * backing figure is those shares marked at the current price — a relevance
 * weight, not a sale price. A sell trims the seller's backings newest first.
 */
export function Comments({
  marketId,
  outcomeIds,
  initial,
  viewer,
  tradable,
  version,
  onChanged,
}: {
  marketId: string;
  /** The market's outcomes in order, for each stake's colour swatch. */
  outcomeIds: string[];
  initial: CommentList;
  viewer: { signedIn: boolean; canTrade: boolean };
  /** Open for trading, which is also when backing is allowed. */
  tradable: boolean;
  /** Bumped by the page after a fill: a sell may have trimmed backings. */
  version: number;
  /** After a backing changes. */
  onChanged: () => void;
}) {
  const [sort, setSort] = useState<Sort>('newest');
  const { data = initial, mutate } = useSWR<CommentList>(
    `/api/v1/markets/${marketId}/comments?limit=50&sort=${sort}`,
    fetchJson,
    { fallbackData: sort === 'newest' ? initial : undefined, refreshInterval: 10_000 },
  );
  useEffect(() => {
    if (version > 0) void mutate();
  }, [version, mutate]);

  const [body, setBody] = useState('');
  const [preview, setPreview] = useState(false);
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
      setPreview(false);
      void mutate();
    } else {
      setError(await errorText(res, 'Could not post.'));
    }
  }

  const available: Available[] = (data.viewer?.available ?? [])
    .map((a) => ({ outcomeId: a.outcomeId, outcomeLabel: a.outcomeLabel, freeMicro: BigInt(a.heldMicro) - BigInt(a.allocatedMicro) }))
    .filter((a) => a.freeMicro > 0n);
  const canBack = viewer.canTrade && tradable;

  const changed = () => {
    void mutate();
    onChanged();
  };

  return (
    <section className="mt-9">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className={ui.section}>
          Discussion ({data.comments.length}
          {data.nextCursor ? '+' : ''})
        </h3>
        <span className="font-sans text-xs text-muted">
          {(['relevance', 'newest'] as const).map((s, i) => (
            <span key={s}>
              {i > 0 && ' · '}
              <button type="button" className={`cursor-pointer ${sort === s ? ui.on : 'hover:underline'}`} onClick={() => setSort(s)}>
                {s}
              </button>
            </span>
          ))}
        </span>
      </div>

      {viewer.canTrade ? (
        <div>
          {preview ? (
            <div className="min-h-[70px] border border-dashed border-rule bg-card p-2">
              {body.trim() ? <Markdown>{body}</Markdown> : <span className="text-muted italic">Nothing to preview.</span>}
            </div>
          ) : (
            <textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} placeholder="Add a comment"
              className="min-h-[70px] w-full border border-rule bg-white p-2 font-sans text-sm narrow:text-base"
            />
          )}
          <div className="flex items-center justify-between gap-3">
            <span className={ui.fine}>
              Shown anonymously, with your position in this market. Markdown and TeX math ($…$, $$…$$) supported.
            </span>
            <span className="flex gap-2">
              <button className={ui.btn({ inline: true, ghost: true })} disabled={body.trim().length === 0 && !preview}
                onClick={() => setPreview((p) => !p)}>
                {preview ? 'Edit' : 'Preview'}
              </button>
              <button className={ui.btn({ inline: true })} disabled={busy || body.trim().length === 0} onClick={post}>
                Post
              </button>
            </span>
          </div>
          {error && <div className={ui.note(false)}>{error}</div>}
        </div>
      ) : (
        <div className={ui.fine}>
          {viewer.signedIn ? 'Only verified accounts can comment.' : <><SignInLink>Sign in</SignInLink> to comment.</>}
        </div>
      )}

      {sort === 'relevance' && data.comments.length > 0 && (
        <div className={ui.fine}>Most backed first, among the 200 most recent comments.</div>
      )}

      {data.comments.map((c) => (
        <CommentItem key={c.id} c={c} outcomeIds={outcomeIds} canBack={canBack} available={available} onChanged={changed} />
      ))}
    </section>
  );
}

function CommentItem({
  c,
  outcomeIds,
  canBack,
  available,
  onChanged,
}: {
  c: Comment;
  outcomeIds: string[];
  canBack: boolean;
  available: Available[];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mine = c.backing.yours.length > 0;
  const offerBack = canBack && !c.author.isYou && available.length > 0;

  async function withdraw() {
    setBusy(true);
    setNote(null);
    const res = await fetch(`/api/v1/comments/${c.id}/backing`, { method: 'DELETE' });
    setBusy(false);
    if (res.ok) onChanged();
    else setNote(await errorText(res, 'Could not withdraw.'));
  }

  return (
    <div className="border-b border-dotted border-rule-strong py-2.5">
      {/* Headed as OpenReview heads a comment: who, what they hold, when. */}
      <div className="flex flex-wrap items-baseline gap-x-2 text-[13px] text-muted">
        <span className={ui.runIn}>{c.author.isYou ? 'Your comment' : 'Anonymous trader'}</span>
        {c.author.isBot && <span className={ui.badge}>bot</span>}
        <span>
          {c.author.stake.length === 0 ? (
            'no position'
          ) : (
            <>
              holding{' '}
              {c.author.stake.map((s, i) => (
                <span key={s.outcomeId}>
                  {i > 0 && ', '}
                  <span className="font-mono text-ink">{shares(s.sharesMicro)}</span>{' '}
                  <OutcomeSwatch ordinal={outcomeIds.indexOf(s.outcomeId)} outcomes={outcomeIds.length} />
                  {s.outcomeLabel}
                </span>
              ))}
            </>
          )}
        </span>
        <span suppressHydrationWarning>· {ago(c.createdAt)} ago</span>
      </div>
      <Markdown className="mt-1">{c.body}</Markdown>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-3 font-sans text-xs text-muted">
        {c.backing.backers > 0 && (
          <span
            className="font-mono text-subtle"
            title={`Shares put behind this comment, marked at current price: ${c.backing.byOutcome
              .map((o) => `${shares(o.sharesMicro)} ${o.outcomeLabel}`)
              .join(', ')}. A relevance weight, not a sale price.`}
          >
            ▲ {rep(c.backing.totalMicro)} {REP} backing · {c.backing.backers} {c.backing.backers === 1 ? 'backer' : 'backers'}
          </span>
        )}
        {mine && (
          <span>
            yours: {c.backing.yours.map((y) => `${shares(y.sharesMicro)} ${c.backing.byOutcome.find((o) => o.outcomeId === y.outcomeId)?.outcomeLabel ?? ''}`).join(', ')}
            {' · '}
            <button type="button" className="cursor-pointer underline disabled:opacity-50" disabled={busy} onClick={withdraw}>
              withdraw
            </button>
          </span>
        )}
        {offerBack && !open && (
          <button type="button" className="cursor-pointer underline" onClick={() => setOpen(true)}>
            back
          </button>
        )}
      </div>
      {offerBack && open && (
        <BackForm
          commentId={c.id}
          available={available}
          onDone={() => {
            setOpen(false);
            onChanged();
          }}
          onCancel={() => setOpen(false)}
        />
      )}
      {note && <div className={ui.note(false)}>{note}</div>}
    </div>
  );
}

function BackForm({
  commentId,
  available,
  onDone,
  onCancel,
}: {
  commentId: string;
  available: Available[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [outcomeId, setOutcomeId] = useState(available[0].outcomeId);
  const chosen = available.find((a) => a.outcomeId === outcomeId) ?? available[0];
  const [amount, setAmount] = useState(shares(chosen.freeMicro).replace(/,/g, ''));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const size = parseUnits(amount);
  const valid = size !== null && size > 0n && size <= chosen.freeMicro;

  async function submit() {
    if (!valid) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/v1/comments/${commentId}/backing`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ outcomeId: chosen.outcomeId, sharesMicro: size.toString() }),
    });
    setBusy(false);
    if (res.ok) onDone();
    else setError(await errorText(res, 'Could not back this comment.'));
  }

  return (
    <div className="mt-2 max-w-[420px] border border-frame bg-card p-2.5 font-sans text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted">Back with</span>
        <input
          className="w-24 border border-rule bg-white px-1.5 py-0.5 text-right font-mono text-[13px] narrow:text-base"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          aria-label="Shares"
        />
        <select
          className="border border-rule bg-white px-1 py-0.5 text-sm narrow:text-base"
          value={chosen.outcomeId}
          onChange={(e) => {
            const next = available.find((a) => a.outcomeId === e.target.value)!;
            setOutcomeId(next.outcomeId);
            setAmount(shares(next.freeMicro).replace(/,/g, ''));
          }}
          aria-label="Outcome"
        >
          {available.map((a) => (
            <option key={a.outcomeId} value={a.outcomeId}>
              {a.outcomeLabel} ({shares(a.freeMicro)} free)
            </option>
          ))}
        </select>
        <span className="text-muted">shares</span>
      </div>
      <div className="mt-1 text-xs text-faint">
        Your shares stay yours; selling them removes your newest backings first.
      </div>
      <div className="flex gap-2">
        <button className={ui.btn({ inline: true })} disabled={busy || !valid} onClick={submit}>
          Back
        </button>
        <button className={ui.btn({ inline: true, ghost: true })} disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
      {error && <div className={ui.note(false)}>{error}</div>}
    </div>
  );
}
