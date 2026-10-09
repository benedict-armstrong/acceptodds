import { venues } from '@/venues';

/** Where an agent reads how to trade here: `app/agent/start/route.ts`. */
export const AGENT_START_PATH = '/agent/start';

/** The name of the key an agent signs in for, so the person can find and revoke it on `/profile`. */
export const AGENT_KEY_NAME = 'ai-agent';

/**
 * The prompt `[onboard your agent]` copies. It has the agent ask one thing at
 * a time. Signed in, it carries the person's login address and a one-time
 * code (`POST /me/agent-code`, an hour), which the agent redeems straight
 * away before asking which papers they find interesting and how to trade.
 * The venue is never asked: the agent reads it off the papers named (a
 * listing's `kind`), any or all of them (one wallet each, §1.8), and asks
 * only when that leaves it unclear. Signed out, the agent asks for the email
 * first (an address with no account gets one, made when the code is
 * redeemed) and, while the person waits for the mailed code
 * (`server/agent-codes.ts`), for those papers and how to trade, then for the
 * code. An agent that already has a key skips the sign-in.
 */
export function agentPrompt(origin: string, signIn?: { email: string; code: string }): string {
  const venueList = venues()
    .map((v) => `- ${v.kind}: each paper's market is on ${v.marketOn}.`)
    .join('\n');
  const venueNote = `I can trade in any or all of them; each has its own wallet of reputation and its own leaderboard. Don't ask me which: work it out from the papers I name (each belongs to one venue), and ask only if that leaves it unclear.`;
  const intro = `Please trade for me on ${origin}, a prediction market on research papers. It is play money (reputation), not real money. It has these venues:

${venueList}

${venueNote}

First read the instructions for agents: ${origin}${AGENT_START_PATH}

Then talk me through it, asking one question at a time and waiting for each answer:`;
  const outro = `Before your first trade, tell me what you plan to buy and why, and wait for my go-ahead. Send "isLlm": true with every order.`;

  if (signIn) {
    return `${intro}

1. Sign in now: exchange this one-time code for an API key as the instructions say (POST /api/v1/agent/token). It works once, within an hour.
   email: ${signIn.email}
   code: ${signIn.code}
2. Ask me which papers I find interesting, maybe my own (titles or links). Suggest a few interesting related papers.
3. Ask me how I want you to trade: on your own, or by first showing me a list of interesting papers (related ones included) to pick from, and any limits (for example only papers in my area, or at most some amount per trade; "up to you" is an answer).

${outro}`;
  }

  return `${intro}

1. If you already have an API key for ${origin} from before, skip to step 3. Otherwise ask me for my institutional email address, and ask the site to mail me a code as the instructions say. I may not have an account yet: the code makes one.
2. While I fetch the code, ask me which papers I find interesting, maybe my own (titles or links), then how I want you to trade: on your own, or by first showing me a list of interesting papers (related ones included) to pick from, and any limits (for example only papers in my area, or at most some amount per trade; "up to you" is an answer). Then ask me for the code and exchange it for an API key.
3. If you skipped here, ask me which papers I find interesting, maybe my own, then how I want you to trade (on your own, or a list first), one at a time.

Once signed in, suggest interesting papers related to the ones I named.

${outro}`;
}
