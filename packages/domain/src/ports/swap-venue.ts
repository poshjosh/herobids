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

/**
 * Balance snapshot for a swap venue.
 *
 * In shared-wallet mode this is observational telemetry, not an authoritative
 * claim that OpenAIdom can explain the entire wallet ledger.
 */
export interface SwapBalanceSnapshot {
  /** Per-asset balances. Crypto: token mint → amount. FX: currency code → amount. */
  balances: Array<{ asset: string; amount: Quantity }>;
  timestamp: string;
}

/**
 * Balance snapshot for a single token on a swap venue.
 *
 * In shared-wallet mode this is observational telemetry for the queried asset.
 */
export interface TokenBalance {
  asset: string;
  amount: Quantity;
  timestamp: string;
}

/**
 * A transaction as reported by the swap venue.
 *
 * In shared-wallet mode this is observational wallet activity, not proof that
 * OpenAIdom owns or can classify every transaction affecting the wallet.
 */
export interface SwapTransaction {
  /** Venue-specific reference (tx hash, deal ticket ID) */
  executionRef: string;
  inputAsset: string;
  outputAsset: string;
  inputAmount: Quantity;
  outputAmount: Quantity;
  timestamp: string;
}

/**
 * Port interface for swap/RFQ venues.
 * Crypto: DEX aggregators (Jupiter, 1inch).
 * TradFi: instant-execution FX/CFD brokers, OTC desks.
 * Lifecycle: quote → execute.
 *
 * Execution methods (`quote`, `executeSwap`) are authoritative for OpenAIdom'
 * own execution pipeline. Balance and transaction fetches are telemetry
 * surfaces that may observe unrelated wallet activity in shared-wallet mode.
 */
export interface SwapVenuePort {
  quote(params: SwapQuoteParams): Promise<Result<SwapQuote, SwapVenueError>>;
  executeSwap(quote: SwapQuote): Promise<Result<SwapReceipt, SwapVenueError>>;

  /** Fetch current venue balances as observational telemetry. */
  fetchBalances(): Promise<Result<SwapBalanceSnapshot, SwapVenueError>>;

  // --- Telemetry methods used by reconciliation and operator visibility ---

  /** Fetch a single token balance as observational telemetry. */
  fetchBalance(token: string): Promise<Result<TokenBalance, SwapVenueError>>;

  /** Fetch recent wallet transactions as observational telemetry. */
  fetchRecentTransactions(since?: Date): Promise<Result<SwapTransaction[], SwapVenueError>>;

  /** Fetch all tradeable token symbols/addresses on this venue. */
  fetchAvailableSymbols?(): Promise<Result<string[], SwapVenueError>>;
}
