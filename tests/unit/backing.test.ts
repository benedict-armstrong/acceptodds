import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { lifoTrim, type BackingSlice } from '@/lib/backing';
import { gifUrl, safeUrl } from '@/lib/markdown';

/** Apply a plan to a newest-first list; returns the survivors, same order. */
function apply(list: BackingSlice[], plan: ReturnType<typeof lifoTrim>): BackingSlice[] {
  return list
    .filter((b) => !plan.remove.includes(b.id))
    .map((b) => (plan.reduce?.id === b.id ? { ...b, sharesMicro: plan.reduce.sharesMicro } : b));
}

const sum = (list: BackingSlice[]) => list.reduce((s, b) => s + b.sharesMicro, 0n);

const backings = fc
  .array(fc.bigInt({ min: 1n, max: 10_000_000_000n }), { maxLength: 12 })
  .map((xs) => xs.map((sharesMicro, i) => ({ id: `b${i}`, sharesMicro })));

describe('lifoTrim', () => {
  it('trims the example from the issue: A 10 then B 10, hold 20, sell 15 → B gone, A 5', () => {
    const newestFirst = [
      { id: 'B', sharesMicro: 10_000_000n },
      { id: 'A', sharesMicro: 10_000_000n },
    ];
    expect(lifoTrim(newestFirst, 5_000_000n)).toEqual({ remove: ['B'], reduce: { id: 'A', sharesMicro: 5_000_000n } });
    expect(lifoTrim(newestFirst, 0n)).toEqual({ remove: ['B', 'A'], reduce: null });
    expect(lifoTrim(newestFirst, 20_000_000n)).toEqual({ remove: [], reduce: null });
  });

  it('leaves exactly min(total, position) and every survivor positive', () => {
    fc.assert(
      fc.property(backings, fc.bigInt({ min: -1_000_000n, max: 200_000_000_000n }), (list, position) => {
        const after = apply(list, lifoTrim(list, position));
        const cap = position > 0n ? position : 0n;
        const total = sum(list);
        expect(sum(after)).toBe(total < cap ? total : cap);
        for (const b of after) expect(b.sharesMicro > 0n).toBe(true);
      }),
    );
  });

  it('takes from the newest first: survivors are an untouched oldest suffix, with at most its newest shrunk', () => {
    fc.assert(
      fc.property(backings, fc.bigInt({ min: 0n, max: 200_000_000_000n }), (list, position) => {
        const plan = lifoTrim(list, position);
        // Removed ids are a prefix of the newest-first list.
        expect(plan.remove).toEqual(list.slice(0, plan.remove.length).map((b) => b.id));
        // The reduced one, if any, is the next after them, and shrinks but survives.
        if (plan.reduce) {
          const next = list[plan.remove.length];
          expect(plan.reduce.id).toBe(next.id);
          expect(plan.reduce.sharesMicro > 0n && plan.reduce.sharesMicro < next.sharesMicro).toBe(true);
        }
      }),
    );
  });

  it('does nothing when the position still covers everything', () => {
    fc.assert(
      fc.property(backings, fc.bigInt({ min: 0n, max: 1_000_000_000n }), (list, extra) => {
        expect(lifoTrim(list, sum(list) + extra)).toEqual({ remove: [], reduce: null });
      }),
    );
  });
});

describe('Markdown link filter', () => {
  it('keeps http(s) and mailto, drops everything else', () => {
    expect(safeUrl('https://arxiv.org/abs/1')).toBe('https://arxiv.org/abs/1');
    expect(safeUrl('HTTP://x.org')).toBe('HTTP://x.org');
    expect(safeUrl('mailto:a@b.org')).toBe('mailto:a@b.org');
    for (const bad of ['javascript:alert(1)', ' javascript:alert(1)', 'data:text/html,x', 'vbscript:x', '/relative', '//evil.org', 'file:///etc/passwd']) {
      expect(safeUrl(bad)).toBe('');
    }
  });
});

describe('Markdown GIF filter', () => {
  it('passes https .gif URLs on the allowlisted hosts', () => {
    expect(gifUrl('https://media.giphy.com/media/abc/giphy.gif')).toBe('https://media.giphy.com/media/abc/giphy.gif');
    expect(gifUrl('https://media.giphy.com/a.gif?cid=1')).toBe('https://media.giphy.com/a.gif?cid=1');
    expect(gifUrl('https://media.tenor.com/x/cat.GIF')).toBe('https://media.tenor.com/x/cat.GIF');
  });
  it('refuses everything else', () => {
    for (const bad of [
      'http://media.giphy.com/a.gif',
      'https://evil.example/a.gif',
      'https://media.giphy.com.evil.example/a.gif',
      'https://user@media.giphy.com/a.gif',
      'https://media.giphy.com/a.png',
      'data:image/gif;base64,R0lGOD',
      '//media.giphy.com/a.gif',
      '',
    ]) {
      expect(gifUrl(bad), bad).toBeNull();
    }
  });
});
