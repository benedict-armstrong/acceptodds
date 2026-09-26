import 'dotenv/config';
import { createAccount, createHouse, startingBalanceMicro } from '@/server/accounts';
import { createMarket } from '@/server/engine';
import { createDb, createPool } from './index';
import { accounts } from './schema';

/**
 * The house account, one market with two outcomes, and two traders.
 *
 * Deliberately knows nothing about papers: the question below is a question,
 * and `../research` is what decides what the venue actually trades on.
 */
async function main() {
  const url = process.argv[2] ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const pool = createPool(url);
  const db = createDb(pool);

  const existing = await db.select().from(accounts);
  if (existing.length > 0) {
    console.log(`database already has ${existing.length} accounts; not seeding`);
    await pool.end();
    return;
  }

  const starting = startingBalanceMicro();

  // The house has to be able to cover every market's b*ln(n). Give it enough
  // to subsidise a few hundred two-outcome markets at this field size.
  const house = await createHouse(starting * 1000n, db);

  const alice = await createAccount(
    { handle: 'alice', displayName: 'Alice', grantMicro: starting },
    db,
  );
  const bot = await createAccount(
    { handle: 'bot-zero', displayName: 'Bot Zero', isBot: true, grantMicro: starting },
    db,
  );

  const closesAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
  const market = await createMarket(
    {
      slug: 'example-binary',
      question: 'Will the example resolve YES?',
      description: 'A seed market. The platform does not know or care what this is about.',
      kind: 'binary',
      outcomes: ['YES', 'NO'],
      closesAt,
      startingBalanceMicro: starting,
      expectedTraders: 50,
      status: 'open',
    },
    db,
  );

  console.log(
    [
      `house       ${house.id}  balance ${house.balanceMicro}`,
      `alice       ${alice.id}  balance ${alice.balanceMicro}`,
      `bot-zero    ${bot.id}  balance ${bot.balanceMicro}`,
      `market      ${market.marketId}  b=${market.b}  subsidy=${market.subsidyMicro}`,
      `outcomes    ${market.outcomeIds.join(', ')}`,
    ].join('\n'),
  );

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
