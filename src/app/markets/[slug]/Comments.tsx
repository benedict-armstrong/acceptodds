'use client';

import { useEffect, useState } from 'react';
import useSWRInfinite from 'swr/infinite';
import type { z } from 'zod';
import { SignInLink } from '@/components/AuthLinks';
import { Markdown } from '@/components/Markdown';
import { MARKDOWN_HINT, MarkdownEditor } from '@/components/MarkdownEditor';
import { OutcomeSwatch } from '@/components/OutcomeBar';
import { ui } from '@/components/ui';
import { userName } from '@/lib/aliases';
import { ago, rep, REP, shares } from '@/lib/format';
import { parseUnits } from '@/lib/money';
import type * as S from '@/server/api/schemas';
import { COMMENT_PAGE, REPLY_PAGE } from './comment-page';

type CommentList = z.output<typeof S.CommentList>;
type Comment = z.output<typeof S.Comment>;
type Replies = z.output<typeof S.CommentReplies>;
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
 * The discussion under a market. Pseudonymous, as OpenReview is: each comment
 * shows its author's alias on this paper ("User k3xm", "(you)" on the
 * viewer's own), their current stake here and a bot badge, nothing else. The
 * alias is the same on all of one author's comments on the paper, so
 * `@k3xm` mentions them. Only accounts that can trade may post, so every
 * voice has something on the line.
 *
 * Traders can put shares they hold behind other people's comments. The
 * backing figure is those shares marked at the current price — a relevance
 * weight, not a sale price. A sell trims the seller's backings newest first.
 *
 * Replies nest, each level indented under the comment it answers. Never
 * read whole: top-level comments come {@link COMMENT_PAGE} at a time with a
 * preview of the replies under them (a flat list the tree is built from by
 * `parentId`), and "more replies" on any comment fetches its next
 * {@link REPLY_PAGE}, each with its own preview.
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
  const base = `/api/v1/markets/${marketId}/comments?limit=${COMMENT_PAGE}&sort=${sort}`;
  const { data, mutate, size, setSize, isValidating } = useSWRInfinite<CommentList>(
    (i, previous: CommentList | null) =>
      i === 0 ? base : previous?.nextCursor ? `${base}&cursor=${encodeURIComponent(previous.nextCursor)}` : null,
    fetchJson,
    {
      fallbackData: sort === 'newest' ? [initial] : undefined,
      refreshInterval: 30_000,
      revalidateOnMount: sort !== 'newest',
    },
  );
  useEffect(() => {
    if (version > 0) void mutate();
  }, [version, mutate]);

  const pages = data ?? [];
  const first = pages[0];
  const last = pages[pages.length - 1];
  const threads = pages.flatMap((p) => p.comments);

  // Replies fetched by "more replies" or posted here, merged with the polled ones (which win: fresher).
  const [extra, setExtra] = useState<Map<string, Comment>>(new Map());
  // Replies posted here, which can land past a gap: "more replies" must not continue after one.
  const [posted, setPosted] = useState<Set<string>>(new Set());
  const known = new Map(extra);
  for (const p of pages) for (const c of [...p.comments, ...p.replies]) known.set(c.id, c);
  const children = new Map<string, Comment[]>();
  for (const c of known.values()) {
    if (c.parentId) children.set(c.parentId, [...(children.get(c.parentId) ?? []), c]);
  }
  for (const list of children.values()) list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const add = (cs: Comment[]) =>
    setExtra((m) => {
      const next = new Map(m);
      for (const c of cs) next.set(c.id, c);
      return next;
    });

  const available: Available[] = (first?.viewer?.available ?? [])
    .map((a) => ({
      outcomeId: a.outcomeId,
      outcomeLabel: a.outcomeLabel,
      freeMicro: BigInt(a.heldMicro) - BigInt(a.allocatedMicro),
    }))
    .filter((a) => a.freeMicro > 0n);
  const canBack = viewer.canTrade && tradable;
  const you = first?.viewer?.alias ?? null;
  // Every alias on the page: what a mention typed in the editor can be previewed against.
  const aliases = new Set([...known.values()].map((c) => c.author.alias));

  const changed = () => {
    void mutate();
    onChanged();
  };

  return (
    <section className="mt-12">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className={ui.section}>Discussion{first ? ` (${first.total})` : ''}</h3>
        <span className="font-sans text-xs text-muted">
          {(['relevance', 'newest'] as const).map((s, i) => (
            <span key={s} className={i > 0 ? 'ml-2' : ''}>
              <button
                type="button"
                className={`cursor-pointer ${sort === s ? ui.on : 'hover:underline'}`}
                onClick={() => setSort(s)}
              >
                {s}
              </button>
            </span>
          ))}
        </span>
      </div>

      {viewer.canTrade ? (
        <CommentForm
          marketId={marketId}
          placeholder="Why is this price justified? Why not?"
          you={you}
          aliases={aliases}
          onPosted={() => void mutate()}
        />
      ) : (
        <div className={ui.fine}>
          {viewer.signedIn ? (
            'Only verified accounts can comment.'
          ) : (
            <>
              <SignInLink>Sign in</SignInLink> to comment.
            </>
          )}
        </div>
      )}

      {sort === 'relevance' && threads.length > 0 && (
        <div className={ui.fine}>Most backed first, among the 200 most recent comments.</div>
      )}

      {threads.map((t) => (
        // One rule under the whole thread, so its replies read as part of it.
        <div key={t.id} className="border-b border-dotted border-rule-strong">
          <Thread
            c={t}
            tree={{
              marketId,
              outcomeIds,
              canReply: viewer.canTrade,
              canBack,
              available,
              you,
              aliases,
              onChanged: changed,
              children: (id) => children.get(id) ?? [],
              loaded: (cs) => add(cs),
              posted: (c) => {
                setPosted((xs) => new Set(xs).add(c.id));
                add([c]);
              },
              isPosted: (id) => posted.has(id),
            }}
          />
        </div>
      ))}

      {last?.nextCursor && size === pages.length && (
        <button
          type="button"
          className={`mt-3 ${ui.btn({ inline: true, ghost: true })}`}
          disabled={isValidating}
          onClick={() => void setSize(size + 1)}
        >
          Load more comments
        </button>
      )}
    </section>
  );
}

/** What every comment in the tree needs from the discussion. */
interface Tree {
  marketId: string;
  outcomeIds: string[];
  canReply: boolean;
  canBack: boolean;
  available: Available[];
  /** The viewer's alias on this paper, null until they comment. */
  you: string | null;
  aliases: ReadonlySet<string>;
  onChanged: () => void;
  /** The loaded direct replies to a comment, oldest first. */
  children: (id: string) => Comment[];
  /** Replies fetched by "more replies". */
  loaded: (cs: Comment[]) => void;
  /** A reply posted here. */
  posted: (c: Comment) => void;
  isPosted: (id: string) => boolean;
}

/**
 * A comment and, indented under it, its replies — each one a `Thread` of its
 * own, so every level of an answer is indented again.
 */
function Thread({ c, tree }: { c: Comment; tree: Tree }) {
  const [busy, setBusy] = useState(false);
  const [replying, setReplying] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const replies = tree.children(c.id);
  const remaining = Math.max(0, c.replyCount - replies.length);

  async function more() {
    setBusy(true);
    setNote(null);
    // Continue after the last reply that came from the server: one posted here may sit past a gap.
    const after = replies.filter((r) => !tree.isPosted(r.id)).at(-1);
    const res = await fetch(`/api/v1/comments/${c.id}/replies?limit=${REPLY_PAGE}${after ? `&after=${after.id}` : ''}`);
    setBusy(false);
    if (!res.ok) return setNote(await errorText(res, 'Could not load replies.'));
    const page: Replies = await res.json();
    tree.loaded(page.replies);
  }

  return (
    <>
      <CommentItem
        c={c}
        outcomeIds={tree.outcomeIds}
        canBack={tree.canBack}
        available={tree.available}
        you={tree.you}
        onChanged={tree.onChanged}
        onReply={tree.canReply ? () => setReplying(true) : undefined}
      />
      {(replies.length > 0 || replying || remaining > 0 || note) && (
        <div className="mb-2 ml-1.5 border-l-2 border-rule-strong pl-5 narrow:pl-3">
          {replies.map((r) => (
            <Thread key={r.id} c={r} tree={tree} />
          ))}
          {remaining > 0 && (
            <button
              type="button"
              className="cursor-pointer py-1.5 font-sans text-xs text-muted underline disabled:opacity-50"
              disabled={busy}
              onClick={more}
            >
              {remaining === 1 ? '1 more reply' : `${remaining} more replies`}
            </button>
          )}
          {note && <div className={ui.note(false)}>{note}</div>}
          {replying && (
            <div className="py-2">
              <CommentForm
                marketId={tree.marketId}
                parentId={c.id}
                placeholder={`Reply to ${userName(c.author.alias)}`}
                you={tree.you}
                aliases={tree.aliases}
                autoFocus
                onPosted={(r) => {
                  tree.posted(r);
                  setReplying(false);
                  tree.onChanged();
                }}
                onCancel={() => setReplying(false)}
              />
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** The editor for a new comment, or with `parentId` a reply. */
function CommentForm({
  marketId,
  parentId,
  placeholder,
  you,
  aliases,
  autoFocus,
  onPosted,
  onCancel,
}: {
  marketId: string;
  parentId?: string;
  placeholder: string;
  you: string | null;
  aliases: ReadonlySet<string>;
  autoFocus?: boolean;
  onPosted: (c: Comment) => void;
  onCancel?: () => void;
}) {
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
      body: JSON.stringify({ body, parentId }),
    });
    setBusy(false);
    if (res.ok) {
      setBody('');
      setPreview(false);
      onPosted(await res.json());
    } else {
      setError(await errorText(res, 'Could not post.'));
    }
  }

  return (
    <div>
      <MarkdownEditor
        value={body}
        onChange={setBody}
        preview={preview}
        placeholder={placeholder}
        autoFocus={autoFocus}
        mentions={aliases}
        you={you}
      />
      <div className="flex items-center justify-between gap-3">
        <span className={ui.fine}>
          Shown as {you ? userName(you) : 'a user id of its own on this paper'}, with your position in this market; @id
          mentions a user and emails them. {MARKDOWN_HINT}
        </span>
        <span className="flex gap-2">
          {onCancel && (
            <button className={ui.btn({ inline: true, ghost: true })} disabled={busy} onClick={onCancel}>
              Cancel
            </button>
          )}
          <button
            className={ui.btn({ inline: true, ghost: true })}
            disabled={body.trim().length === 0 && !preview}
            onClick={() => setPreview((p) => !p)}
          >
            {preview ? 'Edit' : 'Preview'}
          </button>
          <button className={ui.btn({ inline: true })} disabled={busy || body.trim().length === 0} onClick={post}>
            {parentId ? 'Reply' : 'Post'}
          </button>
        </span>
      </div>
      {error && <div className={ui.note(false)}>{error}</div>}
    </div>
  );
}

function CommentItem({
  c,
  outcomeIds,
  canBack,
  available,
  you,
  onChanged,
  onReply,
}: {
  c: Comment;
  outcomeIds: string[];
  canBack: boolean;
  available: Available[];
  you: string | null;
  onChanged: () => void;
  /** Opens the thread's reply form; absent when the viewer cannot comment. */
  onReply?: () => void;
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
    <div className="py-2.5">
      {/* Headed as OpenReview heads a comment: who, what they hold, when. */}
      <div className="flex flex-wrap items-baseline gap-x-2 text-[13px] text-muted">
        <span className={ui.runIn}>
          {userName(c.author.alias)}
          {c.author.isYou && ' (you)'}
        </span>
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
                  <span className="font-mono text-ink">{shares(s.sharesMicro, 1)}</span>{' '}
                  <OutcomeSwatch ordinal={outcomeIds.indexOf(s.outcomeId)} outcomes={outcomeIds.length} />
                  {s.outcomeLabel}
                </span>
              ))}
            </>
          )}
        </span>
        <span suppressHydrationWarning>{ago(c.createdAt)} ago</span>
      </div>
      <Markdown className="mt-1" mentions={new Set(c.mentions)} you={you}>
        {c.body}
      </Markdown>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-3 font-sans text-xs text-muted">
        {c.backing.backers > 0 && (
          <span
            className="font-mono text-subtle"
            title={`Shares put behind this comment, marked at current price: ${c.backing.byOutcome
              .map((o) => `${shares(o.sharesMicro)} ${o.outcomeLabel}`)
              .join(', ')}. A relevance weight, not a sale price.`}
          >
            ▲ {rep(c.backing.totalMicro)} {REP} backing, {c.backing.backers}{' '}
            {c.backing.backers === 1 ? 'backer' : 'backers'}
          </span>
        )}
        {mine && (
          <span>
            yours:{' '}
            {c.backing.yours
              .map(
                (y) =>
                  `${shares(y.sharesMicro)} ${c.backing.byOutcome.find((o) => o.outcomeId === y.outcomeId)?.outcomeLabel ?? ''}`,
              )
              .join(', ')}{' '}
            <button
              type="button"
              className="cursor-pointer underline disabled:opacity-50"
              disabled={busy}
              onClick={withdraw}
            >
              withdraw
            </button>
          </span>
        )}
        {onReply && (
          <button type="button" className="cursor-pointer underline" onClick={onReply}>
            reply
          </button>
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
