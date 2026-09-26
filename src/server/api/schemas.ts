import { z } from 'zod';
import { TOKEN_SCOPES } from '../tokens';
import { API_ERROR_CODES } from './errors';

/**
 * The `/api/v1` contract, as Zod. **One schema per boundary**, used three ways:
 * to parse requests, to validate every response on its way out, and to
 * generate the OpenAPI document (`server/api/openapi.ts`). A field that is not
 * here does not exist in the API.
 *
 * Conventions:
 * - Money and share quantities are integer **micro-units** (1 unit =
 *   1,000,000), named `…Micro`, and serialised as decimal strings so that no
 *   client parses them into a float (invariant §1.6). Requests accept a string
 *   or a JSON integer.
 * - Prices are probabilities in (0, 1), as JSON numbers.
 * - Timestamps are ISO 8601 strings in UTC.
 */

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

const MICRO_DESCRIPTION = 'Integer micro-units (1 unit = 1,000,000), as a decimal string.';

/** Output: a bigint rendered as a decimal string. */
export const Micro = z
  .string()
  .regex(/^-?\d+$/)
  .meta({ description: MICRO_DESCRIPTION, example: '1500000' });

const MAX_INT64 = 9_223_372_036_854_775_807n;

/** Input: a decimal string or a JSON integer, parsed to a `bigint`. */
export const MicroInput = z
  .union([z.string().regex(/^-?\d{1,19}$/), z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER)])
  .transform((v, ctx) => {
    const n = BigInt(v);
    if (n > MAX_INT64 || n < -MAX_INT64) {
      ctx.addIssue({ code: 'custom', message: 'out of range' });
      return z.NEVER;
    }
    return n;
  })
  .meta({
    description: `${MICRO_DESCRIPTION} A JSON integer is also accepted.`,
    example: '10000000',
  });

export const Id = z.uuid();
export const Timestamp = z.iso.datetime({ offset: true });
export const Price = z.number().min(0).max(1).meta({ description: 'Implied probability.' });
export const Cursor = z.string().nullable().meta({
  description: 'Opaque. Pass as `cursor` to get the next page; `null` on the last page.',
});

export const PaginationQuery = z.object({
  cursor: z.string().max(512).optional().meta({ description: 'From a previous page’s `nextCursor`.' }),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** Path parameter: a market's uuid or its slug. */
export const MarketRef = z
  .string()
  .min(1)
  .max(100)
  .meta({ description: 'The market’s id (uuid) or its slug.', example: 'example-binary' });

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

export const ErrorResponse = z
  .object({
    error: z.object({
      code: z.enum(API_ERROR_CODES).meta({
        description: 'Stable and machine-readable. Branch on this, not on `message`.',
      }),
      message: z.string(),
      details: z.record(z.string(), z.unknown()).optional(),
    }),
  })
  .meta({ id: 'Error' });

// ---------------------------------------------------------------------------
// markets
// ---------------------------------------------------------------------------

export const MarketStatus = z.enum(['draft', 'open', 'closed', 'settled', 'void']);

export const OutcomeOnBoard = z
  .object({
    id: Id,
    label: z.string(),
    ordinal: z.number().int(),
    sharesMicro: Micro.meta({ description: 'Outstanding shares of this outcome (the `q_i` of the cost function).' }),
    price: Price,
  })
  .meta({ id: 'Outcome' });

export const Market = z
  .object({
    id: Id,
    slug: z.string(),
    question: z.string(),
    description: z.string().nullable(),
    kind: z.string().meta({ description: 'Opaque to the venue; whatever the creating client groups by.' }),
    status: MarketStatus,
    b: z.number().positive().meta({
      description:
        'LMSR liquidity parameter, in micro-units. Computed once at creation and frozen: it never changes.',
    }),
    outcomes: z.array(OutcomeOnBoard),
    volumeMicro: Micro.meta({ description: 'Sum of |cost| over every fill.' }),
    orderCount: z.number().int(),
    opensAt: Timestamp.nullable(),
    closesAt: Timestamp,
    createdAt: Timestamp,
    resolutionSource: z.string().nullable(),
    resolvedOutcomeId: Id.nullable(),
    resolutionEvidenceUrl: z.string().nullable(),
    settledAt: Timestamp.nullable(),
  })
  .meta({ id: 'Market' });

export const MarketListQuery = PaginationQuery.extend({
  status: MarketStatus.optional().meta({
    description: 'Filter by status. Without it, every market except drafts.',
  }),
  kind: z.string().max(100).optional().meta({ description: 'Filter by the opaque `kind` string.' }),
});

export const MarketList = z
  .object({ markets: z.array(Market), nextCursor: Cursor })
  .meta({ id: 'MarketList' });

export const HistoryPoint = z.object({
  at: Timestamp,
  prices: z.array(Price).meta({ description: 'Every outcome’s price, indexed by `ordinal`.' }),
});

export const PriceHistory = z
  .object({
    marketId: Id,
    outcomes: z.array(z.object({ id: Id, label: z.string(), ordinal: z.number().int() })),
    points: z.array(HistoryPoint).meta({
      description:
        'Oldest first. One point per fill, plus the opening point on the first page. Reconstructed from the fills, not sampled.',
    }),
    nextCursor: Cursor,
  })
  .meta({ id: 'PriceHistory' });

export const TapeEntry = z
  .object({
    id: Id,
    outcomeId: Id,
    sharesMicro: Micro.meta({ description: 'Signed: negative is a sell.' }),
    costMicro: Micro.meta({ description: 'Signed: negative is proceeds paid to the seller.' }),
    priceBefore: Price,
    priceAfter: Price,
    createdAt: Timestamp,
  })
  .meta({ id: 'TapeEntry', description: 'A fill, without the identity of who made it.' });

export const Tape = z
  .object({ orders: z.array(TapeEntry).meta({ description: 'Newest first.' }), nextCursor: Cursor })
  .meta({ id: 'Tape' });

// ---------------------------------------------------------------------------
// quote and trade
// ---------------------------------------------------------------------------

export const QuoteRequest = z
  .object({
    outcomeId: Id,
    sharesMicro: MicroInput.meta({
      description: 'Shares to trade, in micro-shares. Negative to sell. Must not be zero.',
    }),
  })
  .meta({ id: 'QuoteRequest' });

export const Quote = z
  .object({
    marketId: Id,
    outcomeId: Id,
    outcomeLabel: z.string(),
    sharesMicro: Micro,
    costMicro: Micro.meta({
      description:
        'Priced for the whole size, slippage included — not shares × price. Positive is paid; negative is received. Advisory: a trade re-prices.',
    }),
    priceBefore: Price,
    priceAfter: Price,
  })
  .meta({ id: 'Quote' });

export const OrderRequest = z
  .object({
    outcomeId: Id,
    sharesMicro: MicroInput.meta({
      description: 'Shares to trade, in micro-shares. Negative to sell; you may only sell what you hold.',
    }),
    maxCostMicro: MicroInput.meta({
      description:
        'Slippage limit, same sign convention as `costMicro`. The order is re-priced under the market lock and refused with `slippage_exceeded` if the cost is above this. For a sell, pass minus the least proceeds you will accept.',
    }),
  })
  .meta({ id: 'OrderRequest' });

export const Fill = z
  .object({
    orderId: Id,
    marketId: Id,
    outcomeId: Id,
    sharesMicro: Micro,
    costMicro: Micro,
    priceBefore: Price,
    priceAfter: Price,
    balanceAfterMicro: Micro,
    positionAfterMicro: Micro,
    createdAt: Timestamp,
    replayed: z.boolean().meta({
      description: 'True when this is the original fill returned for a retried `Idempotency-Key`.',
    }),
  })
  .meta({ id: 'Fill' });

// ---------------------------------------------------------------------------
// accounts and leaderboard
// ---------------------------------------------------------------------------

export const SettledRecord = z
  .object({
    settledPnlMicro: Micro.meta({
      description: 'Net reputation from trading and settlement, over settled markets only.',
    }),
    settledMarkets: z.number().int(),
  })
  .meta({ id: 'SettledRecord' });

export const LeaderboardEntry = z
  .object({
    rank: z.number().int().min(1),
    handle: z.string(),
    displayName: z.string(),
    isBot: z.boolean(),
    institutionName: z.string().nullable(),
    settledPnlMicro: Micro,
    settledMarkets: z.number().int(),
  })
  .meta({ id: 'LeaderboardEntry' });

export const Leaderboard = z
  .object({
    basis: z.literal('settled_pnl').meta({
      description:
        'Ranked on P&L over settled markets only. Mid-market net worth is never a ranking basis: a trader can mark their own price impact as profit.',
    }),
    entries: z.array(LeaderboardEntry),
    nextCursor: Cursor,
  })
  .meta({ id: 'Leaderboard' });

export const PublicAccount = z
  .object({
    handle: z.string(),
    displayName: z.string(),
    isBot: z.boolean(),
    institutionName: z.string().nullable(),
    rorId: z.string().nullable(),
    verifiedAt: Timestamp.nullable(),
    createdAt: Timestamp,
    settledRecord: SettledRecord,
  })
  .meta({ id: 'PublicAccount' });

export const Me = z
  .object({
    id: Id,
    handle: z.string(),
    displayName: z.string(),
    isBot: z.boolean(),
    institutionName: z.string().nullable(),
    verifiedAt: Timestamp.nullable(),
    balanceMicro: Micro,
    createdAt: Timestamp,
    auth: z.object({
      method: z.enum(['token', 'session']),
      scopes: z.array(z.enum(TOKEN_SCOPES)),
    }),
  })
  .meta({ id: 'Me' });

export const Holding = z
  .object({
    marketId: Id,
    marketSlug: z.string(),
    question: z.string(),
    marketStatus: MarketStatus,
    outcomeId: Id,
    outcomeLabel: z.string(),
    sharesMicro: Micro,
    price: Price,
    markMicro: Micro.meta({
      description:
        'shares × current price. A MARK, NOT A SALE PRICE: closing the position pays `quotedExitMicro`, which is less.',
    }),
    quotedExitMicro: Micro.meta({
      description:
        'What selling the whole holding now would pay: a real quote for the full size, slippage included. Always ≤ `markMicro`.',
    }),
  })
  .meta({ id: 'Holding' });

export const Portfolio = z
  .object({
    accountId: Id,
    balanceMicro: Micro,
    holdings: z.array(Holding),
    unsettledValuation: z
      .object({
        midMarketNetWorthMicro: Micro.meta({
          description: 'balance + Σ markMicro. Noise before settlement: see `caveat`.',
        }),
        liquidationValueMicro: Micro.meta({
          description: 'balance + Σ quotedExitMicro. What you would hold if you sold everything now.',
        }),
        caveat: z.string(),
      })
      .meta({
        description:
          'Valuations of open positions. Neither is a score, and the leaderboard ranks on neither.',
      }),
  })
  .meta({ id: 'Portfolio' });

export const MyOrder = TapeEntry.extend({
  marketId: Id,
  idempotencyKey: z.string().nullable(),
}).meta({ id: 'MyOrder' });

export const MyOrders = z
  .object({ orders: z.array(MyOrder).meta({ description: 'Newest first.' }), nextCursor: Cursor })
  .meta({ id: 'MyOrders' });

export const CreateTokenRequest = z
  .object({
    name: z.string().min(1).max(100),
    scopes: z.array(z.enum(TOKEN_SCOPES)).min(1),
  })
  .meta({ id: 'CreateTokenRequest' });

export const CreatedToken = z
  .object({
    id: Id,
    token: z.string().meta({ description: 'The secret. Shown once, never again.' }),
    name: z.string(),
    scopes: z.array(z.enum(TOKEN_SCOPES)),
    createdAt: Timestamp,
  })
  .meta({ id: 'CreatedToken' });

// ---------------------------------------------------------------------------
// admin
// ---------------------------------------------------------------------------

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CreateMarketRequest = z
  .object({
    slug: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,99}$/, 'lowercase letters, digits and hyphens')
      .refine((s) => !UUID_SHAPE.test(s), 'a slug must not look like a uuid'),
    question: z.string().min(1).max(500),
    description: z.string().max(10_000).nullish(),
    kind: z.string().min(1).max(100).optional().meta({ description: 'Opaque. Defaults to "binary".' }),
    outcomes: z
      .array(z.string().min(1).max(200))
      .min(2)
      .max(20)
      .refine((o) => new Set(o).size === o.length, 'outcome labels must be distinct'),
    closesAt: Timestamp,
    resolutionSource: z.string().max(1000).nullish().meta({ description: 'Opaque to the venue.' }),
    expectedTraders: z.number().int().min(1).max(1_000_000).meta({
      description:
        'The expected field size. With STARTING_BALANCE_MICRO it sizes `b`, once; `b` is then frozen for the life of the market.',
    }),
  })
  .meta({ id: 'CreateMarketRequest' });

export const CreatedMarket = z
  .object({
    market: Market,
    subsidyMicro: Micro.meta({ description: 'b·ln(n), debited from the house treasury.' }),
  })
  .meta({ id: 'CreatedMarket' });

export const SettleRequest = z
  .object({
    winningOutcomeId: Id,
    evidenceUrl: z.url({ protocol: /^https?$/ }).max(2000),
  })
  .meta({ id: 'SettleRequest' });

export const IdempotencyKey = z.string().min(1).max(255).regex(/^[\x21-\x7e]+$/, 'printable ASCII');

export const Handle = z.string().min(1).max(100).meta({ description: 'An account handle.', example: 'alice' });
