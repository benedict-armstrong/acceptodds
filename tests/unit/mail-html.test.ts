import { describe, expect, it } from 'vitest';
import { confirmationMail } from '@/lib/auth-mails';
import { renderMail, type MailDoc } from '@/lib/mail-html';

const doc = (over: Partial<MailDoc> = {}): MailDoc => ({
  siteUrl: 'https://acceptodds.com',
  subject: 'Subject',
  title: 'Title',
  blocks: [],
  ...over,
});

describe('renderMail', () => {
  it('puts a whole long link in one href, hyphens and all', () => {
    const url =
      'https://acceptodds.com/api/auth/verify-email?token=eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6ImEtYkBldGh6LmNoIn0.x-y_z' +
      '&callbackURL=%2Fverify-email%3Fnext%3D%252Fpapers%252Ficlr2027-49923%253Fprice%253Djev';
    const { text, html } = renderMail(doc({ blocks: [{ kind: 'link', label: 'Open', url }] }));
    expect(html).toContain(`href="${url.replace(/&/g, '&amp;')}"`);
    expect(text).toBe(url);
  });

  it('links URLs in text, leaving a full stop after one out of it', () => {
    const { html } = renderMail(doc({ blocks: [{ kind: 'p', text: 'See https://acceptodds.com/profile.' }] }));
    expect(html).toMatch(/<a href="https:\/\/acceptodds.com\/profile"[^>]*>https:\/\/acceptodds.com\/profile<\/a>\./);
  });

  it('escapes everything supplied', () => {
    const { html } = renderMail(
      doc({ title: '<i>t</i>', blocks: [{ kind: 'quote', text: 'Reviewer <b>k3xm</b> & "you"' }] }),
    );
    expect(html).toContain('Reviewer &lt;b&gt;k3xm&lt;/b&gt; &amp; &quot;you&quot;');
    expect(html).not.toContain('<b>k3xm');
    expect(html).not.toContain('<i>t');
  });

  it('writes the plain part from the same blocks, notes after a rule', () => {
    const { text } = renderMail(
      doc({
        blocks: [
          { kind: 'p', text: 'One.' },
          { kind: 'p', text: 'HTML only.', plain: '' },
          { kind: 'quote', text: 'a\nb' },
        ],
        notes: ['Why.', 'Stop.'],
      }),
    );
    expect(text).toBe('One.\n\n> a\n> b\n\n—\nWhy.\nStop.');
  });

  it('keeps the code findable in a confirmation mail’s text and sets it in the HTML', () => {
    const { text, html } = confirmationMail('123456', 'https://acceptodds.com/api/auth/verify-email?token=x');
    expect(text).toMatch(/code is 123456/);
    expect(text).toContain('https://acceptodds.com/api/auth/verify-email?token=x');
    expect(html).toContain('>123456</div>');
  });
});
