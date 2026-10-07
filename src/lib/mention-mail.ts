import { userName } from './aliases';
import { renderMail, type RenderedMail } from './mail-html';

/** How much of the comment a mention mail quotes. */
export const MENTION_QUOTE_CHARS = 800;

export interface MentionMail {
  siteName: string;
  /** The mentioner's alias and the recipient's, on this paper. */
  from: string;
  to: string;
  /** The paper's title, or an unlisted market's question. */
  title: string;
  body: string;
  /** Absolute: where the discussion is read. */
  url: string;
  /** Absolute: where the mail is turned off. */
  settingsUrl: string;
}

/**
 * The mail a `@` mention sends. It names nobody but by alias, as the page
 * does, and quotes the comment as posted (raw Markdown), cut.
 */
export function renderMentionMail(m: MentionMail): RenderedMail {
  const title = m.title.length > 90 ? `${m.title.slice(0, 89).trimEnd()}…` : m.title;
  const body = m.body.length > MENTION_QUOTE_CHARS ? `${m.body.slice(0, MENTION_QUOTE_CHARS).trimEnd()}…` : m.body;
  const lead = `${userName(m.from)} mentioned you (${userName(m.to)}) in the discussion of`;
  return renderMail({
    siteUrl: new URL(m.url).origin,
    subject: `${userName(m.from)} mentioned you on “${title}”`,
    title: 'You were mentioned',
    byline: m.title,
    blocks: [
      { kind: 'p', text: `${lead} this paper:`, plain: `${lead}\n\n  ${m.title}` },
      { kind: 'quote', text: body },
      { kind: 'link', label: 'Read and reply', url: m.url, plain: `Read and reply: ${m.url}` },
    ],
    notes: [
      `You get this because you comment on ${m.siteName} as ${userName(m.to)} on this paper.`,
      `To stop these emails, go to ${m.settingsUrl}`,
    ],
  });
}
