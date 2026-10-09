import 'dotenv/config';
import { parseArgs } from 'node:util';
import { eq } from 'drizzle-orm';
import { getDb, getPool } from '@/db';
import { accounts, type TokenScope } from '@/db/schema';
import { createAccount } from '@/server/accounts';
import { mintToken, TOKEN_SCOPES } from '@/server/tokens';

/**
 * Mint an API token for an account, from the operator's shell.
 *
 * `POST /api/v1/me/tokens` is session-only by design (a token must not be able
 * to mint its successor), and sessions arrive with M5. Until then — and after
 * it, for bot accounts, which never sign in — this is how a token is made.
 *
 *   npm run token:mint -- --handle bot-zero --scopes read,trade --name research
 *   npm run token:mint -- --handle my-bot --create-bot --scopes read,trade
 *
 * `--create-bot` creates the account first, as a bot; like any trader, its
 * first trade in a venue opens a wallet there with STARTING_BALANCE_MICRO. A bot gets a login-less Better Auth user the first
 * time it is issued a token (the API-key plugin keys tokens on users). A human
 * account must already have signed up. The token is printed once and is not
 * recoverable.
 */
async function main() {
  const { values } = parseArgs({
    options: {
      handle: { type: 'string' },
      scopes: { type: 'string', default: 'read' },
      name: { type: 'string' },
      'create-bot': { type: 'boolean', default: false },
      'display-name': { type: 'string' },
      'database-url': { type: 'string' },
    },
  });
  if (!values.handle) throw new Error('--handle is required');

  const scopes = values.scopes.split(',').map((s) => s.trim()) as TokenScope[];
  const unknown = scopes.filter((s) => !(TOKEN_SCOPES as readonly string[]).includes(s));
  if (unknown.length) throw new Error(`unknown scope(s): ${unknown.join(', ')}; use ${TOKEN_SCOPES.join(', ')}`);

  if (values['database-url']) process.env.DATABASE_URL = values['database-url'];
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  const db = getDb();
  try {
    let [account] = await db.select().from(accounts).where(eq(accounts.handle, values.handle));
    if (!account && values['create-bot']) {
      account = await createAccount(
        { handle: values.handle, displayName: values['display-name'] ?? values.handle, isBot: true },
        db,
      );
    }
    if (!account) throw new Error(`no account "${values.handle}" (pass --create-bot to create one)`);
    if (account.isHouse) throw new Error('refusing to mint a token for a house account');

    const { token, record } = await mintToken({ account, name: values.name ?? `${values.handle} token`, scopes });
    console.error(`account ${account.handle} (${account.id})${account.isBot ? ' [bot]' : ''}`);
    console.error(`token   ${record.id}  scopes=${record.scopes.join(',')}  — shown once, store it now:`);
    console.log(token);
  } finally {
    await getPool().end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
