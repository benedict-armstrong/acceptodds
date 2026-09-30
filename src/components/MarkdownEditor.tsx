'use client';

import { Markdown } from './Markdown';

/**
 * A comment's text: a textarea, or with `preview` the Markdown as it will be
 * shown. The caller holds `preview` and puts its Edit/Preview toggle beside
 * its own buttons.
 */
export function MarkdownEditor({
  value,
  onChange,
  preview,
  placeholder,
  autoFocus = false,
}: {
  value: string;
  onChange: (v: string) => void;
  preview: boolean;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  return preview ? (
    <div className="min-h-[70px] border border-dashed border-rule bg-card p-2">
      {value.trim() ? <Markdown>{value}</Markdown> : <span className="text-muted italic">Nothing to preview.</span>}
    </div>
  ) : (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      maxLength={2000}
      placeholder={placeholder}
      autoFocus={autoFocus}
      className="min-h-[70px] w-full border border-rule bg-white p-2 font-sans text-sm narrow:text-base"
    />
  );
}

/** What a comment's text may contain, for the line under the editor. */
export const MARKDOWN_HINT = 'Markdown and TeX math ($…$, $$…$$) supported.';
