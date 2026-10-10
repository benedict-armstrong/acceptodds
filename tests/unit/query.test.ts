import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  containsPattern,
  parseSearch,
  peopleText,
  prefixOf,
  requiredText,
  websearchOf,
  type SearchNode,
} from '@/lib/query';

const text = (include: string[], exclude: string[] = []): SearchNode => ({ kind: 'text', include, exclude });

describe('parseSearch', () => {
  it('merges the words of an AND into one text node', () => {
    const { node, errors } = parseSearch('attention is all you need');
    expect(errors).toEqual([]);
    expect(node).toEqual(text(['attention', 'is', 'all', 'you', 'need']));
  });

  it('keeps phrases quoted and negations on their side', () => {
    expect(parseSearch('graph "neural net" -tree -"decision forest"').node).toEqual(
      text(['graph', '"neural net"'], ['tree', '"decision forest"']),
    );
    expect(parseSearch('`back ticks`').node).toEqual(text(['"back ticks"']));
  });

  it('reads known fields with every operator and alias', () => {
    const { node, fields } = parseSearch('author:hinton t:"deep nets" accept>=70 vol<1.5 fills!=0 s:Open v:iclr');
    expect(node).toEqual({
      kind: 'and',
      items: [
        { kind: 'match', field: 'author', op: '=', value: 'hinton' },
        { kind: 'match', field: 'title', op: '=', value: 'deep nets' },
        { kind: 'compare', field: 'accept', op: '>=', value: '70' },
        { kind: 'compare', field: 'volume', op: '<', value: '1.5' },
        { kind: 'compare', field: 'trades', op: '!=', value: '0' },
        { kind: 'status', op: '=', value: 'open' },
        { kind: 'match', field: 'venue', op: '=', value: 'iclr' },
      ],
    });
    expect([...fields].sort()).toEqual(['accept', 'author', 'status', 'title', 'trades', 'venue', 'volume']);
  });

  it('reads keyword and area, with their aliases', () => {
    const { node, fields } = parseSearch('keyword:rl kw:"graph neural" -area:optimization primaryArea!=theory');
    expect(node).toEqual({
      kind: 'and',
      items: [
        { kind: 'match', field: 'keyword', op: '=', value: 'rl' },
        { kind: 'match', field: 'keyword', op: '=', value: 'graph neural' },
        { kind: 'not', item: { kind: 'match', field: 'area', op: '=', value: 'optimization' } },
        { kind: 'match', field: 'area', op: '!=', value: 'theory' },
      ],
    });
    expect([...fields].sort()).toEqual(['area', 'keyword']);
    expect(parseSearch('area>x').errors).toHaveLength(1);
  });

  it('treats an unknown key as text', () => {
    expect(parseSearch('BERT: pre-training').node).toEqual(text(['BERT:', 'pre-training']));
    expect(parseSearch('http://x.org').node).toEqual(text(['http://x.org']));
  });

  it('drops a bad filter with an error, keeping the rest', () => {
    const { node, errors } = parseSearch('graph accept>abc status:maybe accept>150 title>x trades>1.5 author:');
    expect(node).toEqual(text(['graph']));
    expect(errors).toHaveLength(6);
  });

  it('accepts a trailing % on accept', () => {
    expect(parseSearch('accept>50%').node).toEqual({ kind: 'compare', field: 'accept', op: '>', value: '50' });
  });

  it('reads key:>n as key>n, on number fields only', () => {
    expect(parseSearch('volume:>0').node).toEqual({ kind: 'compare', field: 'volume', op: '>', value: '0' });
    expect(parseSearch('accept:>=50%').node).toEqual({ kind: 'compare', field: 'accept', op: '>=', value: '50' });
    expect(parseSearch('fills:!=0').node).toEqual({ kind: 'compare', field: 'trades', op: '!=', value: '0' });
    expect(parseSearch('accept:=40').node).toEqual({ kind: 'compare', field: 'accept', op: '=', value: '40' });
    expect(parseSearch('title:<x').node).toEqual({ kind: 'match', field: 'title', op: '=', value: '<x' });
    expect(parseSearch('volume:>').errors).toHaveLength(1);
  });

  it('groups with OR and parentheses', () => {
    expect(parseSearch('(venue:iclr OR venue:neurips) diffusion').node).toEqual({
      kind: 'and',
      items: [
        text(['diffusion']),
        {
          kind: 'or',
          items: [
            { kind: 'match', field: 'venue', op: '=', value: 'iclr' },
            { kind: 'match', field: 'venue', op: '=', value: 'neurips' },
          ],
        },
      ],
    });
    expect(parseSearch('a or b').node).toEqual({ kind: 'or', items: [text(['a']), text(['b'])] });
  });

  it('negates filters and groups, and a multi-word group is "not both"', () => {
    expect(parseSearch('-status:settled').node).toEqual({
      kind: 'not',
      item: { kind: 'status', op: '=', value: 'settled' },
    });
    expect(parseSearch('-(a b)').node).toEqual({ kind: 'not', item: text(['a', 'b']) });
    expect(parseSearch('-(a)').node).toEqual(text([], ['a']));
  });

  it('forgives unbalanced parentheses, dangling ORs and lone dashes', () => {
    expect(parseSearch('a) b').node).toEqual(text(['a', 'b']));
    expect(parseSearch('(a OR b').node).toEqual({ kind: 'or', items: [text(['a']), text(['b'])] });
    expect(parseSearch('OR a OR').node).toEqual(text(['a']));
    expect(parseSearch('a - b').node).toEqual(text(['a', 'b']));
    expect(parseSearch('()').node).toBeNull();
    expect(parseSearch('--a').node).toEqual(text([], ['a']));
  });

  it('never throws, and never lets a quote into a word', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (s) => {
        const { node } = parseSearch(s);
        const walk = (n: SearchNode): void => {
          if (n.kind === 'and' || n.kind === 'or') n.items.forEach(walk);
          else if (n.kind === 'not') walk(n.item);
          else if (n.kind === 'text') {
            for (const f of [...n.include, ...n.exclude]) {
              // A phrase is one quoted run; a word has no quote and no leading dash.
              expect(f).toMatch(/^("[^"]+"|[^"\s-][^"\s]*)$/);
            }
          } else if (n.kind === 'compare') expect(n.value).toMatch(/^\d+(\.\d+)?$/);
        };
        if (node) walk(node);
      }),
    );
  });
});

describe('reading the tree', () => {
  it('websearchOf and prefixOf', () => {
    expect(websearchOf({ include: ['a', '"b c"'], exclude: ['d'] })).toBe('a "b c" -d');
    expect(prefixOf({ include: ['attention', 'transf'], exclude: [] })).toBe('attention & transf:*');
    expect(prefixOf({ include: ['a'], exclude: ['d'] })).toBeNull();
    expect(prefixOf({ include: ['"a b"'], exclude: [] })).toBeNull();
  });

  it('requiredText is the root text or a root AND’s', () => {
    expect(requiredText(parseSearch('graph accept>50').node)).toEqual(text(['graph']));
    expect(requiredText(parseSearch('graph').node)).toEqual(text(['graph']));
    expect(requiredText(parseSearch('graph OR accept>50').node)).toBeNull();
    expect(requiredText(parseSearch('-graph accept>50').node)).toBeNull();
    expect(requiredText(parseSearch('accept>50').node)).toBeNull();
    expect(requiredText(null)).toBeNull();
  });

  it('peopleText is plain positive words only', () => {
    expect(peopleText(parseSearch('geoffrey "hinton"').node)).toBe('geoffrey hinton');
    expect(peopleText(parseSearch('hinton accept>5').node)).toBeNull();
    expect(peopleText(parseSearch('a OR b').node)).toBeNull();
    expect(peopleText(parseSearch('a -b').node)).toBeNull();
  });

  it('containsPattern escapes LIKE metacharacters', () => {
    expect(containsPattern('50%_off\\')).toBe('%50\\%\\_off\\\\%');
  });
});
