import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { gifUrl, safeUrl } from '@/lib/markdown';

/**
 * User-written Markdown (GFM) with TeX math (`$…$`, `$$…$$`, via KaTeX; its
 * stylesheet is imported once in `app/layout.tsx`). Safe for untrusted input:
 *
 *   - no raw HTML: react-markdown escapes it, and `rehype-raw` is not used;
 *   - links only to absolute http(s) and mailto URLs, opened in a new tab and
 *     marked `nofollow noopener noreferrer ugc`; anything else loses its href;
 *   - images only as GIFs from `GIF_HOSTS` (`lib/markdown.ts`); any other image
 *     becomes a plain link to it, so a comment cannot make every reader's
 *     browser fetch a URL of its author's choosing;
 *   - KaTeX runs with `trust: false` (its default), so `\href`, `\url` and
 *     friends are inert.
 *
 * Headings are downsized to body text: a comment is not a document.
 */

const components: Components = {
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="nofollow noopener noreferrer ugc">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ src, alt }) =>
    typeof src === 'string' && gifUrl(src) ? (
      // eslint-disable-next-line @next/next/no-img-element -- an allowlisted GIF, shown as written
      <img
        src={gifUrl(src)!}
        alt={alt ?? ''}
        loading="lazy"
        referrerPolicy="no-referrer"
        className="my-1.5 max-h-72 max-w-full"
      />
    ) : typeof src === 'string' && src ? (
      <a href={src} target="_blank" rel="nofollow noopener noreferrer ugc">
        {alt || src}
      </a>
    ) : (
      <span>{alt}</span>
    ),
};

const prose = [
  'break-words',
  '[&>:first-child]:mt-0 [&>:last-child]:mb-0',
  '[&_p]:my-1.5',
  '[&_a]:text-accent [&_a]:underline',
  '[&_:is(h1,h2,h3,h4,h5,h6)]:mt-2.5 [&_:is(h1,h2,h3,h4,h5,h6)]:mb-1 [&_:is(h1,h2,h3,h4,h5,h6)]:text-[15px] [&_:is(h1,h2,h3,h4,h5,h6)]:font-semibold',
  '[&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5',
  '[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-rule-strong [&_blockquote]:pl-3 [&_blockquote]:text-subtle',
  '[&_code]:rounded-[2px] [&_code]:bg-tint [&_code]:px-[3px] [&_code]:font-mono [&_code]:text-[13px]',
  '[&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:bg-tint [&_pre]:p-2 [&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_hr]:my-3 [&_hr]:border-rule',
  '[&_table]:my-2 [&_table]:border-collapse [&_:is(th,td)]:border [&_:is(th,td)]:border-rule [&_:is(th,td)]:px-2 [&_:is(th,td)]:py-0.5 [&_th]:font-semibold',
  '[&_del]:text-muted',
  '[&_.katex-display]:my-2 [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden',
].join(' ');

export function Markdown({ children, className = '' }: { children: string; className?: string }) {
  return (
    <div className={`${prose} ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        urlTransform={safeUrl}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
