/**
 * The HTML part of a mail, made from its text part, so a link is an `href`
 * and not something the reader's client has to find in the text.
 *
 * A text-only mail's links broke: our sign-in and confirmation links run to
 * hundreds of characters, mail software wraps plain text near 78 columns and
 * breaks long lines at hyphens, and the client then links only the first
 * line. A link cut at `/verify-` confirmed the address and landed on a 404.
 * In an `href`, wrapping cannot reach the link.
 *
 * The text is kept as written (`pre-wrap`, so the digest's layout survives);
 * only http(s) URLs become anchors. Everything is escaped.
 */

const URL_PATTERN = /https?:\/\/[^\s<>"]+/g;

export function htmlFromText(text: string): string {
  let body = '';
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    // A sentence's full stop or a closing bracket after a link is not part of it.
    const url = match[0].replace(/[.,;:!?)\]]+$/, '');
    const start = match.index;
    body += escapeHtml(text.slice(last, start));
    body += `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
    last = start + url.length;
  }
  body += escapeHtml(text.slice(last));
  return (
    '<!doctype html><html><body>' +
    '<div style="white-space:pre-wrap;overflow-wrap:anywhere;font-family:Georgia,serif;font-size:15px;line-height:1.5">' +
    body +
    '</div></body></html>'
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
