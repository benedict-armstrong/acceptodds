/**
 * The Milestone 4 "done when", as a script: using nothing but a minted token
 * and HTTP, list markets, quote, trade, and read the portfolio. It imports no
 * app code on purpose — it is what any API client would do.
 *
 *   PM_TOKEN=pm_live_… PM_BASE_URL=http://localhost:3000 npx tsx scripts/api-smoke.ts
 *
 * The token needs the `read` and `trade` scopes.
 */
const base = (process.env.PM_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '') + '/api/v1';
const token = process.env.PM_TOKEN;
if (!token) {
  console.error('PM_TOKEN is not set');
  process.exit(1);
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  const remaining = res.headers.get('x-ratelimit-remaining');
  console.log(`${method} ${path} -> ${res.status}${remaining ? ` (rate limit remaining ${remaining})` : ''}`);
  if (!res.ok) throw new Error(JSON.stringify(json));
  return json;
}

async function main() {
  const me = await call('GET', '/me');
  console.log(`  me: ${me.handle}, balance ${me.balanceMicro} micro, scopes ${me.auth.scopes.join(',')}`);

  const { markets } = await call('GET', '/markets?status=open&limit=10');
  if (markets.length === 0) throw new Error('no open markets to trade on');
  const market = markets[0];
  const outcome = market.outcomes[0];
  console.log(`  market: ${market.slug} — ${market.question}`);
  console.log(`  ${market.outcomes.map((o: { label: string; price: number }) => `${o.label}=${o.price.toFixed(4)}`).join('  ')}`);

  const sharesMicro = '5000000'; // 5 shares
  const quote = await call('POST', `/markets/${market.id}/quote`, { outcomeId: outcome.id, sharesMicro });
  console.log(`  quote: ${sharesMicro} micro-shares of ${quote.outcomeLabel} costs ${quote.costMicro} micro, price ${quote.priceBefore.toFixed(4)} -> ${quote.priceAfter.toFixed(4)}`);

  const key = `smoke-${Date.now()}`;
  const order = { outcomeId: outcome.id, sharesMicro, maxCostMicro: quote.costMicro };
  const fill = await call('POST', `/markets/${market.id}/orders`, order, { 'Idempotency-Key': key });
  console.log(`  fill: order ${fill.orderId}, cost ${fill.costMicro}, balance now ${fill.balanceAfterMicro}`);

  const retry = await call('POST', `/markets/${market.id}/orders`, order, { 'Idempotency-Key': key });
  console.log(`  retry with the same key: replayed=${retry.replayed}, same order=${retry.orderId === fill.orderId}`);

  const portfolio = await call('GET', '/me/portfolio');
  for (const h of portfolio.holdings) {
    console.log(`  holding: ${h.sharesMicro} ${h.outcomeLabel} on ${h.marketSlug}: mark ${h.markMicro}, quoted exit ${h.quotedExitMicro}`);
  }
  console.log(`  balance ${portfolio.balanceMicro}; liquidation value ${portfolio.unsettledValuation.liquidationValueMicro}`);

  const exit = await call('POST', `/markets/${market.id}/quote`, { outcomeId: outcome.id, sharesMicro: `-${sharesMicro}` });
  const sell = await call('POST', `/markets/${market.id}/orders`, {
    outcomeId: outcome.id,
    sharesMicro: `-${sharesMicro}`,
    maxCostMicro: exit.costMicro,
  });
  console.log(`  sold back: proceeds ${-BigInt(sell.costMicro)} micro (paid ${fill.costMicro}); round trip cost ${BigInt(fill.costMicro) + BigInt(sell.costMicro)} micro`);

  console.log('ok');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
