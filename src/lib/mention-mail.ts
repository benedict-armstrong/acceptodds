import { renderMail, type RenderedMail } from './mail-html';

/** How much of the comment a mention mail quotes. */
export const MENTION_QUOTE_CHARS = 800;

export interface MentionMail {
  siteName: string;
  /** The mentioner and the recipient as the page shows them: "User k3xm", or a bot's name. */
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
 * The mail a `@` mention sends. It names people only by alias (and bots by
 * name), as the page does, and quotes the comment as posted (raw Markdown), cut.
 */
export function renderMentionMail(m: MentionMail): RenderedMail {
  const title = m.title.length > 90 ? `${m.title.slice(0, 89).trimEnd()}…` : m.title;
  const body = m.body.length > MENTION_QUOTE_CHARS ? `${m.body.slice(0, MENTION_QUOTE_CHARS).trimEnd()}…` : m.body;
  const lead = `${m.from} mentioned you (${m.to}) in the discussion of`;
  return renderMail({
    siteUrl: new URL(m.url).origin,
    subject: `${m.from} mentioned you on “${title}”`,
    title: 'You were mentioned',
    byline: m.title,
    blocks: [
      { kind: 'p', text: `${lead} this paper:`, plain: `${lead}\n\n  ${m.title}` },
      { kind: 'quote', text: body },
      { kind: 'link', label: 'Read and reply', url: m.url, plain: `Read and reply: ${m.url}` },
    ],
    notes: [
      `You get this because you comment on ${m.siteName} as ${m.to} on this paper.`,
      `To stop these emails, go to ${m.settingsUrl}`,
    ],
  });
}
