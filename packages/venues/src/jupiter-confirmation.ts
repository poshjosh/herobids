/**
 * Jupiter (Solana) on-chain confirmation poller.
 *
 * Checks transaction status via Solana RPC's getSignatureStatuses endpoint.
 * Used to confirm OpenAIdom-submitted swap fills after broadcast.
 *
 * This confirms execution outcome, not complete wallet-accounting truth.
 */

import type { Result } from '@herobids/domain';
import { ok, err } from '@herobids/domain';
import type { SwapConfirmationPoller, SwapConfirmationStatus, SwapConfirmationError } from './swap-confirmation-poller.js';
import type { SolanaSignerPort } from './solana-signer.js';

export interface JupiterConfirmationConfig {
  /** Solana RPC URL */
  rpcUrl: string;
  /** Request timeout in ms */
  timeoutMs?: number;
}

/**
 * Solana-specific confirmation poller.
 * Can use either a SolanaSignerPort (reuses existing connection) or standalone RPC config.
 * The poller answers whether the submitted transaction landed; it does not
 * attempt to explain unrelated wallet activity.
 */
export class JupiterConfirmationPoller implements SwapConfirmationPoller {
  private readonly rpcUrl: string;
  private readonly timeoutMs: number;
  private readonly signer?: SolanaSignerPort;

  constructor(config: JupiterConfirmationConfig, signer?: SolanaSignerPort) {
    this.rpcUrl = config.rpcUrl;
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.signer = signer;
  }

  async checkConfirmation(txRef: string): Promise<Result<SwapConfirmationStatus, SwapConfirmationError>> {
    // Prefer the signer's transaction-status check when available. This keeps
    // execution confirmation tied to the same signing/broadcast surface.
    if (this.signer) {
      const result = await this.signer.getTransactionStatus(txRef);
      if (!result.ok) {
        return err({ code: result.error.code, message: result.error.message });
      }
      return ok({
        confirmed: result.data.confirmed,
        blockNumber: result.data.slot,
        timestamp: result.data.confirmed ? new Date().toISOString() : undefined,
      });
    }

    // Fallback: direct RPC call for authoritative transaction-status lookup.
    try {
      const response = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getSignatureStatuses',
          params: [[txRef], { searchTransactionHistory: true }],
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        return err({ code: 'RPC_ERROR', message: `Solana RPC returned ${response.status}` });
      }

      const data = await response.json() as {
        result?: { value: Array<{ confirmationStatus?: string; slot?: number; err?: unknown } | null> };
      };

      const status = data.result?.value?.[0];
      if (!status) {
        return ok({ confirmed: false });
      }

      if (status.err) {
        return ok({ confirmed: false, failed: true, blockNumber: status.slot });
      }

      const isConfirmed = status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized';
      return ok({
        confirmed: isConfirmed,
        blockNumber: status.slot,
        timestamp: isConfirmed ? new Date().toISOString() : undefined,
      });
    } catch (error) {
      return err({
        code: 'CONFIRMATION_ERROR',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
