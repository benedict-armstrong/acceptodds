'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState, type KeyboardEvent } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/Popover';
import { ui } from '@/components/ui';
import { clip } from '@/lib/format';

/** Longest board name set in the title; the whole name is on hover and in the list. */
const TITLE_MAX = 40;

export interface BoardOption {
  key: string;
  label: string;
  href: string;
  /** Right-aligned, muted: a size. */
  note?: string;
}

/**
 * The leaderboard's board selector, set in its title ("Global leaderboard"):
 * the board's name is a button opening a find box over the boards — global,
 * the viewer's institutions and groups, and, once something is typed, every
 * institution with traders.
 * Arrow keys move, Enter opens. Groups the viewer is not in are never listed.
 * The institution comparison sets one per side in its title.
 */
export function BoardPicker({
  current,
  mine,
  institutions,
  placeholder = 'Find an institution or group',
  tone = 'text-accent',
}: {
  /** The board on screen. */
  current: { label: string; href: string };
  /** Always listed: everyone, then the viewer's institutions and groups, headed by `section`. */
  mine: { section: string | null; options: BoardOption[] }[];
  /** Every institution, listed only when it matches what is typed. */
  institutions: BoardOption[];
  /** The find box's placeholder. */
  placeholder?: string;
  /** The name's colour class: the comparison sets its second side in its own series' colour. */
  tone?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [active, setActive] = useState(0);

  const sections = useMemo(() => {
    const t = text.trim().toLowerCase();
    const match = (o: BoardOption) => t === '' || o.label.toLowerCase().includes(t);
    const listed = new Set(mine.flatMap((s) => s.options.map((o) => o.href)));
    const out = mine.map((s) => ({ ...s, options: s.options.filter(match) }));
    if (t !== '')
      out.push({ section: 'All institutions', options: institutions.filter((o) => !listed.has(o.href) && match(o)) });
    return out.filter((s) => s.options.length > 0);
  }, [text, mine, institutions]);
  const flat = sections.flatMap((s) => s.options);

  function go(o: BoardOption | undefined) {
    if (!o) return;
    setOpen(false);
    router.push(o.href);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActive((a) => (flat.length === 0 ? 0 : (a + step + flat.length) % flat.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(flat[active]);
    }
  }

  // Each section's first index in `flat`, for the active row.
  const starts = sections.map((_, k) => sections.slice(0, k).reduce((n, x) => n + x.options.length, 0));
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        setText('');
        setActive(0);
      }}
    >
      {/* In the title's own type, marked as a field the way the trade box's stake is: a dashed rule, solid on hover or focus. */}
      <PopoverTrigger
        title={current.label.length > TITLE_MAX ? current.label : undefined}
        className={`${ui.picker} ${tone}`}
      >
        {clip(current.label, TITLE_MAX)}
      </PopoverTrigger>
      <PopoverContent className="flex max-h-[60vh] flex-col text-[13px]">
        <input
          type="search"
          autoFocus
          role="combobox"
          aria-expanded
          aria-controls="board-options"
          aria-activedescendant={flat[active] ? `board-option-${active}` : undefined}
          aria-label="Find a board"
          placeholder={placeholder}
          className={ui.input}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKey}
        />
        <div id="board-options" role="listbox" className="-mx-1 overflow-y-auto">
          {sections.length === 0 && <div className="px-1 py-1 italic text-muted">No board matches.</div>}
          {sections.map((s, k) => (
            <div key={s.section ?? ''} role="group" aria-label={s.section ?? undefined}>
              {s.section && (
                <div className="mt-1.5 px-1 text-[11px] tracking-wide text-faint uppercase">{s.section}</div>
              )}
              {s.options.map((o, j) => {
                const n = starts[k] + j;
                return (
                  <div
                    key={o.key}
                    id={`board-option-${n}`}
                    role="option"
                    aria-selected={n === active}
                    onMouseEnter={() => setActive(n)}
                    onClick={() => go(o)}
                    className={`flex cursor-pointer justify-between gap-3 px-1 py-0.5 ${n === active ? 'bg-highlight' : ''} ${o.href === current.href ? 'font-semibold' : ''}`}
                  >
                    <span>{o.label}</span>
                    {o.note && <span className="font-mono text-muted">{o.note}</span>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
