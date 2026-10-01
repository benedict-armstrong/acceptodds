import { describe, expect, it } from 'vitest';
import { renderBadge, textWidth } from '@/lib/badge';

describe('renderBadge', () => {
  const base = { label: 'papermarket', message: '67% accept', color: '#3d7a4f', prices: [0.07, 0.18, 0.42, 0.33] };

  it('draws the label, the message and one bar segment per outcome, worst first', () => {
    const svg = renderBadge(base);
    expect(svg).toContain('>papermarket</text>');
    expect(svg).toContain('>67% accept</text>');
    const fills = [...svg.matchAll(/<rect x="[\d.]+" y="7" width="[\d.]+" height="6" fill="(#[0-9a-f]+)"/g)].map(
      (m) => m[1],
    );
    expect(fills).toEqual(['#a24a3f', '#c49a2c', '#3d7a4f', '#3f6a9a']);
  });

  it('drops the label when compact and the bar when asked or unsupported', () => {
    expect(renderBadge({ ...base, compact: true })).not.toContain('papermarket</text>');
    expect(renderBadge({ ...base, prices: null })).not.toContain('y="7"');
    expect(renderBadge({ ...base, prices: [0.2, 0.2, 0.2, 0.2, 0.2] })).not.toContain('y="7"');
  });

  it('escapes what it is given', () => {
    const svg = renderBadge({ ...base, label: 'a<b>&"c', message: '<script>' });
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('a&lt;b&gt;&amp;&quot;c');
  });

  it('grows with the text', () => {
    expect(textWidth('67% accept')).toBeLessThan(textWidth('Spotlight ✓ and more'));
  });
});
