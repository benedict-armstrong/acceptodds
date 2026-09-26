/**
 * One error shape for the whole venue. The `code` strings are part of the
 * public API contract — bots branch on them, so treat a change as breaking.
 */
export type EngineErrorCode =
  | 'not_found'
  | 'market_not_open'
  | 'market_closed'
  | 'market_already_settled'
  | 'invalid_size'
  | 'insufficient_balance'
  | 'insufficient_shares'
  | 'slippage_exceeded'
  | 'house_underfunded'
  | 'invalid_market';

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: EngineErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.details = details;
  }
}
