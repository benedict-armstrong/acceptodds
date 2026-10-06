import { describe, expect, it } from 'vitest';
import { htmlFromText } from '@/lib/mail-html';

describe('htmlFromText', () => {
  it('puts a whole long link in one href, hyphens and all', () => {
    const url =
      'https://acceptodds.com/api/auth/verify-email?token=eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6ImEtYkBldGh6LmNoIn0.x-y_z' +
      '&callbackURL=%2Fverify-email%3Fnext%3D%252Fpapers%252Ficlr2027-49923%253Fprice%253Djev';
    const html = htmlFromText(`Open this link:\n\n${url}\n\nIt works once.`);
    expect(html).toContain(`<a href="${url.replace(/&/g, '&amp;')}">`);
  });

  it('leaves a full stop after a link out of it', () => {
    expect(htmlFromText('See https://acceptodds.com/profile.')).toContain(
      '<a href="https://acceptodds.com/profile">https://acceptodds.com/profile</a>.',
    );
  });

  it('escapes the text around links', () => {
    const html = htmlFromText('Reviewer <b>k3xm</b> & "you"');
    expect(html).toContain('Reviewer &lt;b&gt;k3xm&lt;/b&gt; &amp; &quot;you&quot;');
    expect(html).not.toContain('<b>');
  });

  it('keeps the text as written', () => {
    expect(htmlFromText('a\n  b')).toContain('a\n  b');
  });
});
