/**
 * Every mail, written once as a list of blocks and rendered twice: a plain
 * text part and an HTML part set like the site, a paper's first page —
 * running head over a rule, a centred title, serif text, a code set like a
 * displayed equation between booktabs rules, booktabs tables with a
 * "Table N." caption, and notes at the foot under a short footnote rule.
 *
 * The HTML part is not decoration. A text-only mail's links broke: our
 * sign-in and confirmation links run to hundreds of characters, mail
 * software wraps plain text near 78 columns and breaks long lines at
 * hyphens, and the client then links only the first line. A link cut at
 * `/verify-` confirmed the address and landed on a 404. In an `href`,
 * wrapping cannot reach the link. Never send a mail without it.
 *
 * Mail clients ignore stylesheets and web fonts, so everything is inline
 * styles over tables, in the system fonts the site's tokens name. `INK` and
 * the rest copy the tokens in `app/globals.css`; keep them in step.
 * Everything supplied is escaped, and only http(s) URLs become links.
 */

const INK = '#1d1d1d';
const BG = '#fbfaf7';
const SUBTLE = '#666';
const MUTED = '#777';
const RULE = '#ddd';
const ACCENT = '#b31b1b';
const UP = '#1a7f37';
const DOWN = '#b31b1b';
const SERIF = "Georgia,'Times New Roman',serif";
const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
const SANS = "-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";

export interface TableCell {
  text: string;
  /** Absolute: the cell links there. */
  href?: string;
  /** A second, smaller line under the text. */
  sub?: string;
  /** Coloured as a gain or a loss (`text-up`/`text-down`). */
  tone?: 'up' | 'down';
}

/**
 * One block of a mail. `plain` replaces the block's default plain-text
 * rendering, for when the text part should say it differently; `''` leaves
 * the block out of it.
 */
export type MailBlock = { plain?: string } & (
  | { kind: 'p'; text: string }
  /** A one-time code, set large between rules; `label` is its small-caps heading. Plain: just `plain`, so say the code there. */
  | { kind: 'code'; label: string; code: string; plain: string }
  /** A button. Plain: the URL on its own line. */
  | { kind: 'link'; label: string; url: string }
  /** Quoted text, as posted. Plain: `> ` lines. */
  | { kind: 'quote'; text: string }
  /** A booktabs table under "Table N." Plain: give `plain`. */
  | {
      kind: 'table';
      caption: string;
      columns: { label: string; numeric?: boolean }[];
      rows: TableCell[][];
      plain: string;
    }
);

export interface MailDoc {
  /** Absolute: the running head links home. */
  siteUrl: string;
  subject: string;
  /** The title on the page. Not in the plain part. */
  title: string;
  /** A muted line under the title, like a paper's author line. Not in the plain part. */
  byline?: string;
  blocks: MailBlock[];
  /** Notes at the foot: why this came, how to stop it. Plain: after a `—`. */
  notes?: string[];
}

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

export function renderMail(doc: MailDoc): RenderedMail {
  return { subject: doc.subject, text: plainOf(doc), html: htmlOf(doc) };
}

function plainOf(doc: MailDoc): string {
  const parts = doc.blocks.map((b) => {
    if (b.plain !== undefined) return b.plain;
    switch (b.kind) {
      case 'p':
        return b.text;
      case 'link':
        return b.url;
      case 'quote':
        return b.text
          .split('\n')
          .map((l) => `> ${l}`.trimEnd())
          .join('\n');
    }
  });
  const text = parts.filter((p) => p !== '').join('\n\n');
  return doc.notes?.length ? `${text}\n\n—\n${doc.notes.join('\n')}` : text;
}

function htmlOf(doc: MailDoc): string {
  let tables = 0;
  const body = doc.blocks
    .map((b) => {
      switch (b.kind) {
        case 'p':
          return `<p style="margin:0 0 16px">${inline(b.text)}</p>`;
        case 'code':
          return (
            `<div style="margin:8px 0 22px;text-align:center">` +
            `<div style="font-family:${SERIF};font-size:15px;font-variant-caps:small-caps;color:${SUBTLE}">${escapeHtml(b.label.toLowerCase())}</div>` +
            `<div style="margin:6px auto 0;display:inline-block;padding:10px 24px;border-top:1.5px solid ${INK};border-bottom:1.5px solid ${INK};font-family:${MONO};font-size:30px;letter-spacing:8px;color:${INK}">${escapeHtml(b.code)}</div>` +
            `</div>`
          );
        case 'link':
          return (
            `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 20px"><tr>` +
            `<td style="background:${ACCENT}"><a href="${escapeHtml(b.url)}" style="display:inline-block;padding:10px 22px;font-family:${SANS};font-size:14px;font-weight:600;color:#fff;text-decoration:none">${escapeHtml(b.label)}</a></td>` +
            `</tr></table>`
          );
        case 'quote':
          return `<blockquote style="margin:0 0 18px;padding:2px 0 2px 14px;border-left:2px solid ${RULE};color:#444;font-size:15px">${inline(b.text)}</blockquote>`;
        case 'table':
          tables += 1;
          return tableHtml(b, tables);
      }
    })
    .join('');

  const notes = doc.notes?.length
    ? `<div style="margin-top:28px;width:33%;border-top:0.5px solid ${INK}"></div>` +
      `<div style="padding-top:6px;font-size:12px;line-height:1.5;color:${MUTED}">${doc.notes.map(inline).join('<br>')}</div>`
    : '';

  // The first sentence, hidden: what a client shows beside the subject in a list.
  const first = doc.blocks.find((b) => b.kind === 'p');
  const preheader = first?.kind === 'p' ? first.text.replace(/\s+/g, ' ').slice(0, 140) : '';

  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">' +
    `<title>${escapeHtml(doc.subject)}</title></head>` +
    `<body style="margin:0;padding:0;background:${BG}">` +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(preheader)}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG}"><tr><td align="center" style="padding:28px 16px 40px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px"><tr><td style="font-family:${SERIF};font-size:16px;line-height:1.55;color:${INK};overflow-wrap:anywhere;word-break:break-word">` +
    `<div style="padding-bottom:2px;border-bottom:1px solid ${RULE};font-size:15px;color:${SUBTLE}">` +
    // The site header's wordmark (`components/Wordmark.tsx`): "accept" in ink, "odds" in the accent.
    `<a href="${escapeHtml(doc.siteUrl)}" style="color:${INK};text-decoration:none">accept<span style="color:${ACCENT}">odds</span></a></div>` +
    `<h1 style="margin:36px 0 ${doc.byline ? 8 : 28}px;font-family:${SERIF};font-size:26px;line-height:1.3;font-weight:normal;text-align:center;color:${INK}">${escapeHtml(doc.title)}</h1>` +
    (doc.byline
      ? `<div style="margin:0 0 28px;font-size:15px;text-align:center;color:${SUBTLE}">${escapeHtml(doc.byline)}</div>`
      : '') +
    body +
    notes +
    '</td></tr></table></td></tr></table></body></html>'
  );
}

function tableHtml(b: Extract<MailBlock, { kind: 'table' }>, n: number): string {
  const align = (numeric?: boolean) => (numeric ? 'right' : 'left');
  const head = b.columns
    .map(
      (c, i) =>
        `<th style="padding:5px ${i === b.columns.length - 1 ? 0 : 10}px 5px 0;border-bottom:1px solid ${INK};font-weight:normal;font-style:italic;text-align:${align(c.numeric)};white-space:nowrap">${escapeHtml(c.label)}</th>`,
    )
    .join('');
  const rows = b.rows
    .map(
      (row) =>
        '<tr>' +
        row
          .map((cell, i) => {
            const numeric = b.columns[i]?.numeric;
            const color = cell.tone === 'up' ? UP : cell.tone === 'down' ? DOWN : INK;
            const text = cell.href
              ? `<a href="${escapeHtml(cell.href)}" style="color:${INK};text-decoration:none">${escapeHtml(cell.text)}</a>`
              : escapeHtml(cell.text);
            const sub = cell.sub
              ? `<div style="font-size:13px;color:${SUBTLE};font-family:${SERIF}">${escapeHtml(cell.sub)}</div>`
              : '';
            return `<td style="padding:6px ${i === row.length - 1 ? 0 : 10}px 6px 0;vertical-align:top;text-align:${align(numeric)};color:${color};${numeric ? `font-family:${MONO};font-size:14px;white-space:nowrap` : ''}">${text}${sub}</td>`;
          })
          .join('') +
        '</tr>',
    )
    .join('');
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 22px;border-collapse:collapse;border-top:1.5px solid ${INK};border-bottom:1.5px solid ${INK};font-size:15px">` +
    `<caption style="padding-bottom:6px;caption-side:top;text-align:left;font-size:13px;color:${SUBTLE}"><b style="color:${INK}">Table ${n}.</b> ${escapeHtml(b.caption)}</caption>` +
    `<thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`
  );
}

const URL_PATTERN = /https?:\/\/[^\s<>"]+/g;

/** Text as written: escaped, line breaks kept, http(s) URLs as links. */
function inline(text: string): string {
  let out = '';
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    // A sentence's full stop or a closing bracket after a link is not part of it.
    const url = match[0].replace(/[.,;:!?)\]]+$/, '');
    out += escapeHtml(text.slice(last, match.index));
    out += `<a href="${escapeHtml(url)}" style="color:${ACCENT}">${escapeHtml(url)}</a>`;
    last = match.index + url.length;
  }
  out += escapeHtml(text.slice(last));
  return out.replace(/\n/g, '<br>');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
