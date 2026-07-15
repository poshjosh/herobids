/**
 * Swap confirmation poller interface.
 *
 * For v1, on-chain fill confirmation uses polling rather than WebSocket subscriptions.
 * Each venue has its own confirmation implementation.
 *
 * Confirmation is authoritative for execution outcome: whether OpenAIdom'
 * submitted transaction landed on-chain. It is not, by itself, a claim about
 * full-wallet accounting truth in shared-wallet mode.
 */

import type { Result } from '@herobids/domain';
import type { Quantity } from '@herobids/domain';

export interface SwapConfirmationStatus {
  confirmed: boolean;
  /** Transaction was included on-chain but reverted / failed definitively */
  failed?: boolean;
  blockNumber?: number;
  timestamp?: string;
  /** Actual output amount parsed from on-chain events when available */
  actualOutputAmount?: Quantity;
}

export interface SwapConfirmationError {
  code: string;
  message: string;
}

/**
 * Port interface for checking on-chain swap transaction confirmation.
 */
export interface SwapConfirmationPoller {
  /** Check whether OpenAIdom' submitted transaction has been confirmed on-chain. */
  checkConfirmation(txRef: string): Promise<Result<SwapConfirmationStatus, SwapConfirmationError>>;
}
