import { splitMentions } from './aliases';

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

/** The little of mdast that {@link remarkMentions} touches. */
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown>; hChildren?: unknown[] };
}

/** Where an `@` is not a mention: code, maths, and link text (a link is already a link). */
const NO_MENTIONS = new Set(['inlineCode', 'code', 'inlineMath', 'math', 'link', 'linkReference']);

/**
 * A remark plugin: each `@k3xm` naming one of `known` becomes a
 * `<span class="mention" data-alias="k3xm">`, and `className(alias)` styles
 * it. Any other `@word` stays text, so a mention never points at nobody.
 */
export function remarkMentions(known: ReadonlySet<string>, className: (alias: string) => string) {
  return () => (tree: MdNode) => {
    if (known.size === 0) return;
    const walk = (node: MdNode) => {
      if (!node.children || NO_MENTIONS.has(node.type)) return;
      node.children = node.children.flatMap((child): MdNode[] => {
        if (child.type !== 'text') {
          walk(child);
          return [child];
        }
        return splitMentions(child.value ?? '', known).map((part) =>
          typeof part === 'string'
            ? { type: 'text', value: part }
            : {
                type: 'mention',
                data: {
                  hName: 'span',
                  hProperties: { className: className(part.alias), dataAlias: part.alias },
                  hChildren: [{ type: 'text', value: part.text }],
                },
              },
        );
      });
    };
    walk(tree);
  };
}
