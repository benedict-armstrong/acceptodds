/**
 * The link filter for user-written Markdown (`components/Markdown.tsx`):
 * absolute http(s) and mailto URLs pass, anything else — `javascript:`,
 * `data:`, relative and protocol-relative paths — becomes `''`, which
 * react-markdown renders without an href.
 */
const SAFE_URL = /^(https?:\/\/|mailto:)/i;

export function safeUrl(url: string): string {
  const u = url.trim();
  return SAFE_URL.test(u) ? u : '';
}
