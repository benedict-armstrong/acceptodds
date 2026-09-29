import 'dotenv/config';
import { createAccount, createHouse, startingBalanceMicro } from '@/server/accounts';
import { createMarket } from '@/server/engine';
import { upsertListing } from '@/server/listings';
import { createDb, createPool } from './index';
import { accounts } from './schema';

/**
 * The house account, one standalone market with two outcomes, one example
 * listing with three markets, and two traders.
 *
 * Deliberately knows nothing about papers: the questions below are questions,
 * the listing is example text, and `../research` is what decides what the
 * venue actually lists and trades on. (The UI calls a listing a paper.)
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

  // An example listing: opaque text and links, as a creating client would
  // send them. Rank 0 is its main market.
  const { listing } = await upsertListing(
    {
      slug: 'example-listing',
      title: 'An Example Listing: Grouping Several Markets Under One Subject',
      summary:
        'This is placeholder text standing in for whatever summary the creating client supplies. ' +
        'The venue stores it for display and never reads it. It is long enough to show the collapsed ' +
        'view on the listing page: a few lines, then a toggle to read the rest. Nothing here refers to ' +
        'a real document, and every link below points at example.org.',
      authors: ['Example Author', 'Second Author', 'Third Author', 'Fourth Author'],
      links: [
        { label: 'PDF', url: 'https://example.org/example-listing.pdf' },
        { label: 'OpenReview', url: 'https://example.org/forum?id=example-listing' },
      ],
      kind: 'example',
    },
    db,
  );
  const listed = [];
  for (const [rank, [suffix, question]] of [
    ['accept', 'Will the example subject be accepted?'],
    ['oral', 'Will the example subject get an oral?'],
    ['award', 'Will the example subject win an award?'],
  ].entries()) {
    listed.push(
      await createMarket(
        {
          slug: `example-listing-${suffix}`,
          question,
          kind: 'example',
          outcomes: ['YES', 'NO'],
          closesAt,
          startingBalanceMicro: starting,
          expectedTraders: 50,
          status: 'open',
          listingId: listing.id,
          listingRank: rank,
        },
        db,
      ),
    );
  }

  console.log(
    [
      `house       ${house.id}  balance ${house.balanceMicro}`,
      `alice       ${alice.id}  balance ${alice.balanceMicro}`,
      `bot-zero    ${bot.id}  balance ${bot.balanceMicro}`,
      `market      ${market.marketId}  b=${market.b}  subsidy=${market.subsidyMicro}`,
      `outcomes    ${market.outcomeIds.join(', ')}`,
      `listing     ${listing.id}  markets ${listed.map((m) => m.marketId).join(', ')}`,
    ].join('\n'),
  );

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
