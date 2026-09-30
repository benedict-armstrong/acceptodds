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

/**
 * The one kind of image a comment may embed: an https `.gif` on a GIF host.
 * Anything else stays a link, so a comment still cannot make readers' browsers
 * fetch a URL of its author's choosing — only one of these few CDNs.
 */
export const GIF_HOSTS = ['media.giphy.com', 'i.giphy.com', 'media.tenor.com'];

export function gifUrl(url: string): string | null {
  try {
    const u = new URL(url.trim());
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    if (!GIF_HOSTS.includes(u.hostname) || !u.pathname.toLowerCase().endsWith('.gif')) return null;
    return u.href;
  } catch {
    return null;
  }
}
