import type {
  SwapVenuePort,
  SwapQuoteParams,
  SwapQuote,
  SwapReceipt,
  SwapBalanceSnapshot,
  SwapVenueError,
  TokenBalance,
  SwapTransaction,
} from '@herobids/domain';
import type { Result } from '@herobids/domain';
import { ok, err, quantity } from '@herobids/domain';

export interface JupiterSwapConfig {
  /** Jupiter API base URL. Default: https://quote-api.jup.ag/v6 */
  apiUrl?: string;
  /** RPC URL for on-chain balance lookups */
  rpcUrl?: string;
  /** Wallet public key for balance/transaction queries */
  walletAddress: string;
  /** Request timeout in ms. Default: 10000 */
  timeoutMs?: number;
}

/**
 * Jupiter DEX aggregator adapter implementing SwapVenuePort.
 * Used for Solana token swaps. In shadow mode, only `quote()` is called
 * (no execution) to obtain real quoted prices for fill simulation.
 */
export class JupiterSwapAdapter implements SwapVenuePort {
  private readonly apiUrl: string;
  private readonly rpcUrl: string;
  private readonly walletAddress: string;
  private readonly timeoutMs: number;

  constructor(config: JupiterSwapConfig) {
    this.apiUrl = config.apiUrl ?? 'https://quote-api.jup.ag/v6';
    this.rpcUrl = config.rpcUrl ?? 'https://api.mainnet-beta.solana.com';
    this.walletAddress = config.walletAddress;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  async quote(params: SwapQuoteParams): Promise<Result<SwapQuote, SwapVenueError>> {
    try {
      const base = this.apiUrl.endsWith('/') ? this.apiUrl : `${this.apiUrl}/`;
      const url = new URL('quote', base);
      url.searchParams.set('inputMint', params.inputAsset);
      url.searchParams.set('outputMint', params.outputAsset);
      url.searchParams.set('amount', params.amount.toString());
      url.searchParams.set('slippageBps', String(params.slippageBps));

      const response = await fetch(url.toString(), {
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        return err({
          code: 'QUOTE_FAILED',
          message: `Jupiter quote API returned ${response.status}: ${await response.text()}`,
        });
      }

      const data = await response.json() as {
        inputMint: string;
        outputMint: string;
        inAmount: string;
        outAmount: string;
        otherAmountThreshold: string;
        priceImpactPct: string;
      };

      return ok({
        quoteData: data,
        inputAsset: data.inputMint,
        outputAsset: data.outputMint,
        inputAmount: quantity(data.inAmount),
        expectedOutputAmount: quantity(data.outAmount),
        minimumOutputAmount: quantity(data.otherAmountThreshold),
        priceImpact: parseFloat(data.priceImpactPct) / 100,
        expiresAt: new Date(Date.now() + 30_000).toISOString(), // Jupiter quotes are short-lived
      });
    } catch (error) {
      return err({
        code: 'QUOTE_ERROR',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async executeSwap(quote: SwapQuote): Promise<Result<SwapReceipt, SwapVenueError>> {
    try {
      const base = this.apiUrl.endsWith('/') ? this.apiUrl : `${this.apiUrl}/`;
      const url = new URL('swap', base);
      const response = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: quote.quoteData,
          userPublicKey: this.walletAddress,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        return err({
          code: 'SWAP_FAILED',
          message: `Jupiter swap API returned ${response.status}: ${await response.text()}`,
        });
      }

      const data = await response.json() as { swapTransaction: string; txid?: string };

      // In a real implementation, sign and submit the transaction here.
      // For now, return the transaction reference.
      return ok({
        executionRef: data.txid ?? 'pending-signature',
        inputAmount: quote.inputAmount,
        outputAmount: quote.expectedOutputAmount,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      return err({
        code: 'SWAP_ERROR',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async fetchBalances(): Promise<Result<SwapBalanceSnapshot, SwapVenueError>> {
    try {
      const response = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTokenAccountsByOwner',
          params: [
            this.walletAddress,
            { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
            { encoding: 'jsonParsed' },
          ],
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        return err({ code: 'BALANCE_FETCH_FAILED', message: `RPC returned ${response.status}` });
      }

      const data = await response.json() as {
        result?: { value: Array<{ account: { data: { parsed: { info: { mint: string; tokenAmount: { uiAmountString: string } } } } } }> };
      };

      const balances = (data.result?.value ?? []).map((item) => ({
        asset: item.account.data.parsed.info.mint,
        amount: quantity(item.account.data.parsed.info.tokenAmount.uiAmountString),
      }));

      return ok({ balances, timestamp: new Date().toISOString() });
    } catch (error) {
      return err({ code: 'BALANCE_ERROR', message: error instanceof Error ? error.message : String(error) });
    }
  }

  async fetchBalance(token: string): Promise<Result<TokenBalance, SwapVenueError>> {
    const balancesResult = await this.fetchBalances();
    if (!balancesResult.ok) return balancesResult as unknown as Result<TokenBalance, SwapVenueError>;

    const match = balancesResult.data.balances.find((b) => b.asset === token);
    return ok({
      asset: token,
      amount: match ? match.amount : quantity('0'),
      timestamp: new Date().toISOString(),
    });
  }

  async fetchRecentTransactions(since?: Date): Promise<Result<SwapTransaction[], SwapVenueError>> {
    try {
      const response = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getSignaturesForAddress',
          params: [this.walletAddress, { limit: 50 }],
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        return err({ code: 'TX_FETCH_FAILED', message: `RPC returned ${response.status}` });
      }

      const data = await response.json() as {
        result?: Array<{ signature: string; blockTime: number }>;
      };

      const sinceTs = since ? since.getTime() / 1000 : 0;
      const txs: SwapTransaction[] = (data.result ?? [])
        .filter((tx) => tx.blockTime > sinceTs)
        .map((tx) => ({
          executionRef: tx.signature,
          inputAsset: 'unknown', // Full parsing requires getTransaction — out of scope for Phase 2b
          outputAsset: 'unknown',
          inputAmount: quantity('0'),
          outputAmount: quantity('0'),
          timestamp: new Date(tx.blockTime * 1000).toISOString(),
        }));

      return ok(txs);
    } catch (error) {
      return err({ code: 'TX_ERROR', message: error instanceof Error ? error.message : String(error) });
    }
  }
}
