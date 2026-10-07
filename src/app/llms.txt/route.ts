import { siteName, siteUrl } from '@/server/share';
import { topPapers } from '@/server/seo';

export const dynamic = 'force-dynamic';

/**
 * `/llms.txt` (llmstxt.org): a plain Markdown map of the site for language-
 * model agents. Written from the same public data the pages show; prices
 * only ever as the pages show them, never as a sale value (§1.1).
 */
export async function GET() {
  const origin = siteUrl();
  const name = siteName();
  // A failed read is a 500, never an empty list the edge would cache.
  const papers = await topPapers(25);
  const body = `# ${name}

> A prediction market on the fate of research papers, traded in reputation (play money, not real money). Each paper has a market on its decision, e.g. Oral, Spotlight, Poster or Reject; prices are the crowd's probabilities. Traders are people with a confirmed institutional email, and bots using API keys.

Prices on a page are probabilities, not guarantees. A holding's displayed value is what selling it would pay, which is less than shares times price. Net worth on the leaderboard is at liquidation value.

## Read the site

- [Home](${origin}/): papers by venue, sortable by acceptance odds, volume or activity; search with \`?q=\`
- [How it works](${origin}/how-it-works): the market maker (LMSR), reputation, settlement
- [Leaderboard](${origin}/leaderboard): traders ranked by net worth or settled profit

## API

- [Instructions for agents](${origin}/agent/start): trading for a person with their API key, start here
- [API reference](${origin}/docs): interactive documentation
- [OpenAPI document](${origin}/api/v1/openapi.json): the full machine-readable contract
- Reads are public and need no key: \`GET ${origin}/api/v1/listings\`, \`/api/v1/markets\`, \`/api/v1/leaderboard\`. Each paper is a listing with its markets; \`?q=\` searches.
- Amounts are decimal strings in micro-units (1 unit = 1,000,000 micro).
- Trading needs an API key with the \`trade\` scope, made by a signed-in user on the profile page.

## Most traded open papers
${papers.map((p) => `\n- [${p.title.replace(/[\[\]]/g, '')}](${origin}/papers/${encodeURIComponent(p.slug)})${p.kind ? `: ${p.kind}` : ''}`).join('')}

## Optional

- [Sitemap](${origin}/sitemap.xml): every paper
`;
  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
}
