import { rep } from '@/lib/format';
import { defaultMarketKind } from '@/lib/venue';
import { startingBalanceMicro } from '@/server/accounts';
import { siteName, siteUrl } from '@/server/share';

export const dynamic = 'force-dynamic';

/**
 * `/agent/start`: how an AI agent trades for the person who pasted
 * `[onboard your agent]`'s prompt (`lib/agent-prompt.ts`), starting with
 * signing in by a code mailed to the person (`server/agent-codes.ts`). Plain
 * Markdown, like `/llms.txt`, and only what the OpenAPI document already says, put in the
 * order an agent needs it. Values are exit quotes, never marks (§1.1).
 */
export function GET() {
  const origin = siteUrl();
  const api = `${origin}/api/v1`;
  const kind = defaultMarketKind();
  const body = `# Trading on ${siteName()} for someone

You are trading for a researcher who pasted you a prompt asking you to. ${siteName()} is a prediction market on whether research papers are accepted (now: ${kind}). Each paper is a **listing**; its main **market** has the outcomes \`Accept\` and \`Reject\` (a withdrawal or desk rejection settles as Reject). A share pays 1 if its outcome happens and 0 if not, so an outcome's price is the crowd's probability. Money is reputation, play money with no cash value; every account starts with ${rep(startingBalanceMicro(), 0)} reputation.

## First, sign in

You need an API key that acts as the person. If you already have one for this site from an earlier session, check it with \`GET ${api}/me\` and skip this section. **If the prompt gave you an email and a code, go straight to step 4** with them: that code works once, within 15 minutes. Otherwise get a code mailed to the person, asking one question at a time:

1. Ask the person for the email address they use on ${siteName()}, and nothing else yet.
2. Ask for a code to be mailed to it:

   \`\`\`
   POST ${api}/agent/code
   Content-Type: application/json

   { "email": "<their address>" }
   \`\`\`

3. While they fetch the mail, ask which papers they find interesting, maybe their own (titles or links), then how they want you to trade (below). Then ask for the 6-digit code in that mail (subject "… is your ${siteName()} agent code"). If the address has no account, the mail tells them how to make one instead; then start again.
4. Trade the address and the code for the key:

   \`\`\`
   POST ${api}/agent/token
   Content-Type: application/json

   { "email": "<their address>", "code": "<6 digits>" }
   \`\`\`

The answer's \`token\` (\`pm_live_…\`) is the key. It can read and trade as the person and is shown only this once, so keep it for the whole session, and send it as \`Authorization: Bearer <key>\` on every call below. A code works once, within 30 minutes; after five wrong tries it is gone. On \`invalid_code\`, ask for a new code (step 2). \`email_domain_not_allowed\` means the address is not at an approved institution.

## Rules

- Send the key only to \`${api}\`. Never print it back, log it or send it anywhere else.
- Send \`"isLlm": true\` in every order body. It is how the venue tells your orders from the person's own.
- Ask before your first trade: say what you would buy, at what price, and why, and wait for a yes. Keep to what the person asked for.
- Before trading, ask, one question at a time if you skipped the sign-in: "Which papers do you find interesting, maybe your own?" Those papers anchor what the person knows best: start there.
- Then suggest papers the person may find interesting: the related and cited papers of the ones they named (\`/related\`, \`/citations\` below), each with a line on why and its current odds.
- Ask whether you should trade autonomously, or first present a list of interesting papers with what you would buy, for them to pick from. Do what they choose, within any limits they set.
- Never trade on information the public does not have, such as a decision the person has seen early.

## Amounts

Money and shares go over the wire as **decimal strings in micro-units**: 1 unit = \`"1000000"\`. Requests also take a JSON integer. Never parse them into a float to do arithmetic you then send back.

## Find papers

- \`GET ${api}/listings?q=<words>&kind=${encodeURIComponent(kind)}\`: search by title, authors or abstract, best match first. Each listing has \`id\`, \`slug\`, \`title\`, \`authors\`, \`summary\` and \`markets\` (main market first; empty while nobody has opened one). A paper's page is \`${origin}/papers/<slug>\`, so a link the person gives you names its slug.
- \`GET ${api}/listings/<id or slug>\`: one listing.
- \`GET ${api}/listings/<id>/text\`: the paper's full text, when the venue has it (\`text: null\` otherwise; then read the \`summary\`).
- \`GET ${api}/listings/<id>/related\` and \`/citations\`: neighbouring papers, with their odds.
- \`GET ${api}/markets/<id>\`: the board. Each outcome has \`id\`, \`label\` and \`price\` (a probability). \`status\` must be \`open\` and \`closesAt\` in the future to trade.

## Trade

- **Buy by stake** (simplest): \`POST ${api}/listings/<id>/orders\` with \`{ "outcome": "Accept", "stakeMicro": "50000000", "isLlm": true }\`. It spends at most the stake, and opens the paper's market first if nobody has (at a model's estimate).
- **Quote first**: \`POST ${api}/markets/<id>/quote\` with \`{ "outcomeId": "…", "sharesMicro": "…" }\` gives \`costMicro\` for the whole size, slippage included. Prices move as you buy.
- **Buy or sell shares**: \`POST ${api}/markets/<id>/orders\` with \`{ "outcomeId": "…", "sharesMicro": "…", "maxCostMicro": "…", "isLlm": true }\`. Pass the quote's \`costMicro\` as \`maxCostMicro\`; a worse price is refused with \`slippage_exceeded\`. **To sell, send negative \`sharesMicro\`** and minus the least you will take as \`maxCostMicro\`. You can only sell shares you hold.
- Send an \`Idempotency-Key\` header (any unique string) with every order and reuse it when you retry the same order: a repeat returns the original fill instead of buying twice.

## Your account

- \`GET ${api}/me\`: the account and its balance.
- \`GET ${api}/me/portfolio\`: holdings. \`quotedExitMicro\` is what selling now would pay; \`markMicro\` (shares × price) is **not** a sale price and is always more. Judge a position by \`quotedExitMicro\`.
- \`GET ${api}/me/orders\`: your fills, newest first.

## Errors

Errors are \`{ "error": { "code", "message" } }\`. The ones you will meet: \`slippage_exceeded\` (quote again), \`insufficient_balance\`, \`insufficient_shares\`, \`market_closed\`, \`not_verified\` (the person has not confirmed an institutional email: tell them), \`rate_limited\` (wait; \`Retry-After\` says how long).

## Reference

- [OpenAPI document](${origin}/api/v1/openapi.json): every endpoint and field.
- [API reference](${origin}/docs), [How it works](${origin}/how-it-works).
`;
  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
}
