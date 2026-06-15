/**
 * EVM on-chain confirmation poller.
 *
 * Checks transaction receipt status via JSON-RPC's eth_getTransactionReceipt.
 * Used to confirm HeroBids-submitted swap fills after broadcast on EVM chains (1inch, etc.).
 *
 * This confirms execution outcome, not complete wallet-accounting truth.
 */

import type { Result } from '@herobids/domain';
import { ok, err } from '@herobids/domain';
import type { SwapConfirmationPoller, SwapConfirmationStatus, SwapConfirmationError } from './swap-confirmation-poller.js';

export interface EvmConfirmationConfig {
  /** JSON-RPC URL for the target EVM chain */
  rpcUrl: string;
  /** Request timeout in ms. Default: 10000 */
  timeoutMs?: number;
}

/**
 * EVM-specific confirmation poller.
 * Checks transaction receipt for a given tx hash to determine whether
 * the swap transaction has been included in a block and succeeded.
 */
export class EvmConfirmationPoller implements SwapConfirmationPoller {
  private readonly rpcUrl: string;
  private readonly timeoutMs: number;

  constructor(config: EvmConfirmationConfig) {
    this.rpcUrl = config.rpcUrl;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  async checkConfirmation(txRef: string): Promise<Result<SwapConfirmationStatus, SwapConfirmationError>> {
    try {
      const response = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'eth_getTransactionReceipt',
          params: [txRef],
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        return err({ code: 'RPC_ERROR', message: `EVM RPC returned ${response.status}` });
      }

      const data = await response.json() as {
        result?: {
          status?: string;
          blockNumber?: string;
        } | null;
        error?: { message?: string };
      };

      if (data.error) {
        return err({ code: 'RPC_ERROR', message: data.error.message ?? 'Unknown RPC error' });
      }

      const receipt = data.result;
      if (!receipt) {
        // No receipt means tx is not yet mined (still pending or unknown)
        return ok({ confirmed: false });
      }

      // status '0x1' = success, '0x0' = reverted
      const confirmed = receipt.status === '0x1';
      const failed = receipt.status === '0x0';
      const blockNumber = receipt.blockNumber
        ? parseInt(receipt.blockNumber, 16)
        : undefined;

      return ok({
        confirmed,
        failed,
        blockNumber,
        timestamp: confirmed ? new Date().toISOString() : undefined,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        return err({ code: 'TIMEOUT', message: `EVM RPC timed out after ${this.timeoutMs}ms` });
      }
      return err({
        code: 'RPC_ERROR',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
