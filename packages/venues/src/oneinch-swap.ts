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
import { ok, err, quantity, Decimal } from '@herobids/domain';
import { EvmSigner } from './evm-signer.js';
import type { EvmSignerConfig } from './evm-signer.js';
import { TokenBucketRateLimiter } from './rate-limiter.js';
import { parseAbiItem, type Log } from 'viem';

export interface OneInchSwapConfig {
  /** 1inch Swap API base URL (includes chain path, e.g. https://api.1inch.dev/swap/v6.0/8453) */
  apiUrl: string;
  /** 1inch developer portal API key (required for rate-limit tier) */
  apiKey: string;
  /** EVM signer config (private key + RPC URL + chain) */
  signer: EvmSignerConfig;
  /** Request timeout in ms. Default: 60000 */
  timeoutMs?: number;
  /** 1inch API requests per second. Default: 1 (free tier safe default). */
  rateLimitPerSec?: number;
  /** Token decimals cache: address → decimals. Pre-populated known tokens. */
  tokenDecimals?: Record<string, number>;
}

/** Native ETH address placeholder used by 1inch API */
const NATIVE_TOKEN_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as `0x${string}`;

/**
 * 1inch DEX aggregator adapter implementing SwapVenuePort.
 * Supports any EVM chain — parameterized by chain ID via signer config.
 * Default: Base (chain ID 8453).
 */
export class OneInchSwapAdapter implements SwapVenuePort {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly signer: EvmSigner;
  private readonly timeoutMs: number;
  private readonly rateLimiter: TokenBucketRateLimiter;
  private readonly decimalsCache: Map<string, number>;
  private readonly assetIds: Map<string, string>;

  constructor(config: OneInchSwapConfig) {
    this.apiUrl = config.apiUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
    this.signer = new EvmSigner(config.signer);
    this.timeoutMs = config.timeoutMs ?? 60_000;
    const rateLimitPerSec = config.rateLimitPerSec ?? 1;
    this.rateLimiter = new TokenBucketRateLimiter({
      capacity: rateLimitPerSec,
      refillRate: rateLimitPerSec,
    });
    this.decimalsCache = new Map();
    this.assetIds = new Map();

    for (const [assetId, decimals] of Object.entries(config.tokenDecimals ?? {})) {
      const normalizedAssetId = this.normalizeAssetId(assetId);
      this.assetIds.set(normalizedAssetId, assetId);
      this.decimalsCache.set(normalizedAssetId, decimals);
    }
  }

  private normalizeAssetId(assetId: string): string {
    return assetId.toLowerCase();
  }

  private isNativeAsset(assetId: string): boolean {
    return this.normalizeAssetId(assetId) === NATIVE_TOKEN_ADDRESS;
  }

  private rememberAssetId(assetId: string): string {
    const normalizedAssetId = this.normalizeAssetId(assetId);
    const canonicalAssetId = this.assetIds.get(normalizedAssetId) ?? assetId;
    this.assetIds.set(normalizedAssetId, canonicalAssetId);
    return canonicalAssetId;
  }

  private getCanonicalAssetId(assetId: string): string {
    return this.assetIds.get(this.normalizeAssetId(assetId)) ?? assetId;
  }

  private async waitForApiToken(): Promise<void> {
    await this.rateLimiter.waitForToken();
  }

  private async ensureAllowance(
    tokenAddress: `0x${string}`,
    spenderAddress: `0x${string}`,
    requiredAmount: bigint,
  ): Promise<void> {
    const currentAllowance = await this.signer.readErc20Allowance(
      tokenAddress,
      this.signer.address,
      spenderAddress,
    );

    if (currentAllowance >= requiredAmount) {
      return;
    }

    let approvalResult = await this.signer.approveErc20(tokenAddress, spenderAddress, requiredAmount);
    // Only attempt zero-reset when the tx reverted on-chain (likely non-zero-to-non-zero restriction).
    // Transient failures (RPC timeout, nonce issues) should not revoke an otherwise usable allowance.
    if (!approvalResult.ok && currentAllowance > 0n && approvalResult.error.code === 'evm.tx_reverted') {
      const resetResult = await this.signer.approveErc20(tokenAddress, spenderAddress, 0n);
      if (!resetResult.ok) {
        throw new Error(
          `Failed to reset allowance for ${this.getCanonicalAssetId(tokenAddress)}: ${resetResult.error.message}`,
        );
      }
      approvalResult = await this.signer.approveErc20(tokenAddress, spenderAddress, requiredAmount);
    }

    if (!approvalResult.ok) {
      throw new Error(
        `Failed to approve ${this.getCanonicalAssetId(tokenAddress)} for 1inch spender ${spenderAddress}: ${approvalResult.error.message}`,
      );
    }
  }

  /** Fetch and cache ERC-20 decimals on-chain. Fails loudly if the call reverts. */
  private async getDecimals(tokenAddress: string): Promise<number> {
    const normalizedTokenAddress = this.normalizeAssetId(tokenAddress);
    this.rememberAssetId(tokenAddress);
    const cached = this.decimalsCache.get(normalizedTokenAddress);
    if (cached !== undefined) return cached;

    if (normalizedTokenAddress === NATIVE_TOKEN_ADDRESS) {
      this.decimalsCache.set(normalizedTokenAddress, 18);
      return 18;
    }

    try {
      const decimals = await this.signer.readErc20Decimals(tokenAddress as `0x${string}`);
      this.decimalsCache.set(normalizedTokenAddress, decimals);
      return decimals;
    } catch (error) {
      throw new Error(
        `Failed to fetch decimals for token ${tokenAddress}: ${error instanceof Error ? error.message : String(error)}. ` +
        'Non-standard token or unreachable RPC.',
      );
    }
  }

  /** Convert human-readable amount to raw wei/smallest-unit bigint string */
  private toRawAmount(amount: string, decimals: number): string {
    const d = new Decimal(amount);
    const fixed = d.toFixed(decimals, Decimal.ROUND_DOWN);
    const parts = fixed.split('.');
    const intPart = parts[0] ?? '0';
    const fracPart = (parts[1] ?? '').padEnd(decimals, '0').slice(0, decimals);
    return BigInt(intPart + fracPart).toString();
  }

  /** Convert raw smallest-unit string to human-readable amount */
  private fromRawAmount(raw: string, decimals: number): string {
    if (decimals === 0) return raw;
    const padded = raw.padStart(decimals + 1, '0');
    const intPart = padded.slice(0, padded.length - decimals);
    const fracPart = padded.slice(padded.length - decimals);
    return `${intPart}.${fracPart}`.replace(/\.?0+$/, '') || '0';
  }

  async quote(params: SwapQuoteParams): Promise<Result<SwapQuote, SwapVenueError>> {
    try {
      const inputAsset = this.rememberAssetId(params.inputAsset);
      const outputAsset = this.rememberAssetId(params.outputAsset);
      const inputDecimals = await this.getDecimals(inputAsset);
      const outputDecimals = await this.getDecimals(outputAsset);
      const rawAmount = this.toRawAmount(params.amount.toString(), inputDecimals);

      const url = new URL(`${this.apiUrl}/quote`);
      url.searchParams.set('src', inputAsset);
      url.searchParams.set('dst', outputAsset);
      url.searchParams.set('amount', rawAmount);

      await this.waitForApiToken();
      const response = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        return err({
          code: 'QUOTE_FAILED',
          message: `1inch quote API returned ${response.status}: ${await response.text()}`,
        });
      }

      const data = await response.json() as {
        srcToken: { address: string };
        dstToken: { address: string };
        toAmount: string;
      };

      this.rememberAssetId(data.srcToken.address);
      this.rememberAssetId(data.dstToken.address);

      const expectedOutput = this.fromRawAmount(data.toAmount, outputDecimals);
      // Apply slippage to compute minimum output
      const slippageMultiplier = new Decimal(1).minus(new Decimal(params.slippageBps).div(10_000));
      const minimumOutput = new Decimal(expectedOutput).mul(slippageMultiplier).toFixed(outputDecimals, Decimal.ROUND_DOWN);

      return ok({
        quoteData: { ...data, _slippageBps: params.slippageBps },
        inputAsset,
        outputAsset,
        inputAmount: quantity(params.amount.toString()),
        expectedOutputAmount: quantity(expectedOutput),
        minimumOutputAmount: quantity(minimumOutput),
        priceImpact: 0, // 1inch API v6 does not return price impact in quote response
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
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
      const inputAsset = this.rememberAssetId(quote.inputAsset);
      const outputAsset = this.rememberAssetId(quote.outputAsset);
      const inputDecimals = await this.getDecimals(inputAsset);
      const rawAmount = this.toRawAmount(quote.inputAmount.toString(), inputDecimals);

      // Extract slippage from quote (stored during quote()) — convert bps to percent for 1inch API
      const quotePayload = quote.quoteData as { _slippageBps?: number };
      const slippagePct = quotePayload._slippageBps !== undefined
        ? (quotePayload._slippageBps / 100).toString()
        : '1';

      // Ensure allowance BEFORE fetching swap calldata so the calldata is fresh when broadcast.
      // Use an initial /swap call to discover the router (spender) address, then re-fetch after approval.
      let approvedSpender: string | undefined;
      if (!this.isNativeAsset(inputAsset)) {
        const spenderUrl = new URL(`${this.apiUrl}/swap`);
        spenderUrl.searchParams.set('src', inputAsset);
        spenderUrl.searchParams.set('dst', outputAsset);
        spenderUrl.searchParams.set('amount', rawAmount);
        spenderUrl.searchParams.set('from', this.signer.address);
        spenderUrl.searchParams.set('slippage', slippagePct);
        spenderUrl.searchParams.set('disableEstimate', 'true');

        await this.waitForApiToken();
        const spenderResponse = await fetch(spenderUrl.toString(), {
          headers: { Authorization: `Bearer ${this.apiKey}` },
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (!spenderResponse.ok) {
          return err({
            code: 'SWAP_FAILED',
            message: `1inch swap API returned ${spenderResponse.status}: ${await spenderResponse.text()}`,
          });
        }

        const spenderData = await spenderResponse.json() as { tx: { to: string } };
        approvedSpender = spenderData.tx.to.toLowerCase();
        await this.ensureAllowance(
          inputAsset as `0x${string}`,
          spenderData.tx.to as `0x${string}`,
          BigInt(rawAmount),
        );
      }

      // Fetch fresh swap calldata — routes and prices are current as of this moment
      const url = new URL(`${this.apiUrl}/swap`);
      url.searchParams.set('src', inputAsset);
      url.searchParams.set('dst', outputAsset);
      url.searchParams.set('amount', rawAmount);
      url.searchParams.set('from', this.signer.address);
      url.searchParams.set('slippage', slippagePct);
      url.searchParams.set('disableEstimate', 'true');

      await this.waitForApiToken();
      const response = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        return err({
          code: 'SWAP_FAILED',
          message: `1inch swap API returned ${response.status}: ${await response.text()}`,
        });
      }

      const data = await response.json() as {
        tx: {
          to: string;
          data: string;
          value: string;
          gas: number;
        };
        toAmount: string;
      };

      // If the spender changed between /swap calls, re-approve the new spender
      if (approvedSpender && data.tx.to.toLowerCase() !== approvedSpender) {
        await this.ensureAllowance(
          inputAsset as `0x${string}`,
          data.tx.to as `0x${string}`,
          BigInt(rawAmount),
        );
      }

      // Sign and submit via EVM signer
      const txResult = await this.signer.sendTransaction({
        to: data.tx.to as `0x${string}`,
        data: data.tx.data as `0x${string}`,
        value: BigInt(data.tx.value),
        gas: BigInt(data.tx.gas),
      });

      if (!txResult.ok) {
        return err({
          code: 'SWAP_TX_FAILED',
          message: txResult.error.message,
        });
      }

      const outputDecimals = await this.getDecimals(outputAsset);
      const outputAmount = this.fromRawAmount(data.toAmount, outputDecimals);

      return ok({
        executionRef: txResult.data.transactionHash,
        inputAmount: quote.inputAmount,
        outputAmount: quantity(outputAmount),
        timestamp: new Date().toISOString(),
        gasUsed: txResult.data.gasUsed.toString(),
      } as SwapReceipt);
    } catch (error) {
      return err({
        code: 'SWAP_ERROR',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async fetchBalances(): Promise<Result<SwapBalanceSnapshot, SwapVenueError>> {
    try {
      const address = this.signer.address;
      const balances: SwapBalanceSnapshot['balances'] = [];

      // Fetch native ETH balance
      const nativeBalance = await this.signer.readNativeBalance(address);
      if (nativeBalance > 0n) {
        balances.push({
          asset: NATIVE_TOKEN_ADDRESS,
          amount: quantity(this.fromRawAmount(nativeBalance.toString(), 18)),
        });
      }

      // For ERC-20 tokens: iterate over known tokens in the decimals cache
      for (const [tokenAddress, decimals] of this.decimalsCache.entries()) {
        if (tokenAddress === NATIVE_TOKEN_ADDRESS) continue;
        try {
          const balance = await this.signer.readErc20Balance(
            tokenAddress as `0x${string}`,
            address,
          );
          if (balance > 0n) {
            balances.push({
              asset: this.getCanonicalAssetId(tokenAddress),
              amount: quantity(this.fromRawAmount(balance.toString(), decimals)),
            });
          }
        } catch (tokenErr) {
          // Log but don't fail the entire snapshot — partial data is preferable to no data.
          // Reconciler will retry on next cycle; drift detection catches real issues.
          console.warn(`[1inch] Failed to read ERC-20 balance for ${tokenAddress}: ${tokenErr instanceof Error ? tokenErr.message : String(tokenErr)}`);
        }
      }

      return ok({ balances, timestamp: new Date().toISOString() });
    } catch (error) {
      return err({ code: 'BALANCE_ERROR', message: error instanceof Error ? error.message : String(error) });
    }
  }

  async fetchBalance(token: string): Promise<Result<TokenBalance, SwapVenueError>> {
    try {
      const assetId = this.rememberAssetId(token);
      const address = this.signer.address;
      let rawBalance: bigint;
      let decimals: number;

      if (this.isNativeAsset(assetId)) {
        rawBalance = await this.signer.readNativeBalance(address);
        decimals = 18;
      } else {
        decimals = await this.getDecimals(assetId);
        rawBalance = await this.signer.readErc20Balance(assetId as `0x${string}`, address);
      }

      return ok({
        asset: assetId,
        amount: quantity(this.fromRawAmount(rawBalance.toString(), decimals)),
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      return err({ code: 'BALANCE_ERROR', message: error instanceof Error ? error.message : String(error) });
    }
  }

  async fetchRecentTransactions(since?: Date): Promise<Result<SwapTransaction[], SwapVenueError>> {
    try {
      const publicClient = this.signer.getPublicClient();
      const address = this.signer.address;

      // Query ERC-20 Transfer events where our address is sender or recipient
      const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

      const currentBlock = await publicClient.getBlockNumber();
      // Approximate: ~2s blocks on Base. Look back ~1 hour if no `since`, or compute from timestamp.
      const lookbackBlocks = since
        ? BigInt(Math.ceil((Date.now() - since.getTime()) / 2000))
        : 1800n;
      const fromBlock = currentBlock > lookbackBlocks ? currentBlock - lookbackBlocks : 0n;

      const [sentLogs, receivedLogs] = await Promise.all([
        publicClient.getLogs({
          event: transferEvent,
          args: { from: address },
          fromBlock,
          toBlock: currentBlock,
        }),
        publicClient.getLogs({
          event: transferEvent,
          args: { to: address },
          fromBlock,
          toBlock: currentBlock,
        }),
      ]);

      // Merge and deduplicate by tx hash
      const txMap = new Map<string, Log>();
      for (const log of [...sentLogs, ...receivedLogs]) {
        if (log.transactionHash) {
          txMap.set(log.transactionHash, log);
        }
      }

      const txs: SwapTransaction[] = [];
      for (const [txHash, log] of txMap.entries()) {
        // Get block timestamp
        let timestamp: string;
        if (log.blockNumber) {
          const block = await publicClient.getBlock({ blockNumber: log.blockNumber });
          timestamp = new Date(Number(block.timestamp) * 1000).toISOString();
        } else {
          timestamp = new Date().toISOString();
        }

        txs.push({
          executionRef: txHash,
          inputAsset: 'unknown', // Full swap parsing requires trace analysis — out of scope for v1
          outputAsset: 'unknown',
          inputAmount: quantity('0'),
          outputAmount: quantity('0'),
          timestamp,
        });
      }

      return ok(txs);
    } catch (error) {
      return err({ code: 'TX_ERROR', message: error instanceof Error ? error.message : String(error) });
    }
  }
}
