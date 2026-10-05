import { describe, expect, it } from 'vitest';
import { MENTION_QUOTE_CHARS, renderMentionMail } from '@/lib/mention-mail';

const base = {
  siteName: 'acceptodds',
  from: 'k3xm',
  to: 'ab2c',
  title: 'Attention Is All You Need',
  body: 'line one\nline two',
  url: 'https://acceptodds.com/papers/attention',
  settingsUrl: 'https://acceptodds.com/profile#email',
};

describe('renderMentionMail', () => {
  it('names both by alias, quotes the comment and links back and to the setting', () => {
    const { subject, text } = renderMentionMail(base);
    expect(subject).toBe('User k3xm mentioned you on “Attention Is All You Need”');
    expect(text).toContain('User k3xm mentioned you (User ab2c)');
    expect(text).toContain('> line one\n> line two');
    expect(text).toContain(base.url);
    expect(text).toContain(base.settingsUrl);
  });

  it('cuts a long comment and a long title', () => {
    const { subject, text } = renderMentionMail({ ...base, title: 't'.repeat(200), body: 'x'.repeat(5000) });
    expect(subject.length).toBeLessThan(140);
    expect(text).toContain(`${'x'.repeat(MENTION_QUOTE_CHARS)}…`);
    expect(text).not.toContain('x'.repeat(MENTION_QUOTE_CHARS + 1));
  });
});
