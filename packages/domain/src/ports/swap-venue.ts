import type { Result, DomainError } from '../result.js';
import type { Quantity } from '../values/money.js';

/** Swap venue error */
export interface SwapVenueError extends DomainError {
  code: string;
}

/** Parameters for requesting a swap quote */
export interface SwapQuoteParams {
  /** Asset to sell. Crypto: token mint address. Forex: currency code (e.g. "USD"). */
  inputAsset: string;
  /** Asset to buy. Crypto: token mint address. Forex: currency code (e.g. "GBP"). */
  outputAsset: string;
  amount: Quantity;
  slippageBps: number;
}

/** A quote returned by a swap venue */
export interface SwapQuote {
  /** Opaque quote data needed to execute (venue-specific payload) */
  quoteData: unknown;
  /** Asset being sold. Crypto: token mint address. Forex: currency code. */
  inputAsset: string;
  /** Asset being bought. Crypto: token mint address. Forex: currency code. */
  outputAsset: string;
  inputAmount: Quantity;
  expectedOutputAmount: Quantity;
  /** Minimum output after slippage */
  minimumOutputAmount: Quantity;
  /** Price impact as a decimal (0.01 = 1%) */
  priceImpact: number;
  /** Quote expiry (ISO 8601) */
  expiresAt: string;
}

/** Receipt from an executed swap */
export interface SwapReceipt {
  /** Venue-specific execution reference. Crypto: tx hash. FX: deal ticket ID. */
  executionRef: string;
  inputAmount: Quantity;
  outputAmount: Quantity;
  timestamp: string;
}

/** Balance for a swap venue */
export interface SwapBalanceSnapshot {
  /** Per-asset balances. Crypto: token mint → amount. FX: currency code → amount. */
  balances: Array<{ asset: string; amount: Quantity }>;
  timestamp: string;
}

/**
 * Port interface for swap/RFQ venues.
 * Crypto: DEX aggregators (Jupiter, 1inch).
 * TradFi: instant-execution FX/CFD brokers, OTC desks.
 * Lifecycle: quote → execute.
 */
export interface SwapVenuePort {
  quote(params: SwapQuoteParams): Promise<Result<SwapQuote, SwapVenueError>>;
  executeSwap(quote: SwapQuote): Promise<Result<SwapReceipt, SwapVenueError>>;
  fetchBalances(): Promise<Result<SwapBalanceSnapshot, SwapVenueError>>;
}
