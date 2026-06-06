import type {
  SwapVenuePort,
  SwapQuoteParams,
  SwapQuote,
  SwapReceipt,
  SwapBalanceSnapshot,
  SwapVenueError,
  TokenBalance,
  SwapTransaction,
  VenueProfile,
} from '@herobids/domain';
import type { Result } from '@herobids/domain';
import { ok, err, quantity, Decimal } from '@herobids/domain';
import { EvmSigner } from './evm-signer.js';
import type { EvmSignerConfig } from './evm-signer.js';
import { TokenBucketRateLimiter } from './rate-limiter.js';
import { parseAbiItem } from 'viem';

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
  /** 1inch aggregation router address. When set, fetchRecentTransactions filters
   *  to only report swaps where a Transfer counterparty matches this address.
   *  Without it, any bidirectional transfer is reported (LP deposits, staking, etc.). */
  routerAddress?: string;
}

/** Native ETH address placeholder used by 1inch API */
const NATIVE_TOKEN_ADDRESS = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as `0x${string}`;

interface ParsedTransferGroup {
  blockNumber?: bigint;
  sent: Map<string, bigint>;
  received: Map<string, bigint>;
  counterparties: Set<string>;
}

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
  private readonly routerAddress?: string;

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
    this.routerAddress = config.routerAddress
      ? this.normalizeAssetId(config.routerAddress)
      : undefined;

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

  private addTransferAmount(totals: Map<string, bigint>, asset: string, amountRaw: bigint): void {
    const existing = totals.get(asset) ?? 0n;
    totals.set(asset, existing + amountRaw);
  }

  private async pickDominantTransfer(totals: Map<string, bigint>): Promise<{ asset: string; amount: string } | undefined> {
    let best:
      | { asset: string; amountRaw: bigint; decimals: number; normalizedAmount: Decimal }
      | undefined;

    for (const [asset, amountRaw] of totals.entries()) {
      const decimals = await this.getDecimals(asset);
      const humanAmount = this.fromRawAmount(amountRaw.toString(), decimals);
      const normalizedAmount = new Decimal(humanAmount);
      if (!best || normalizedAmount.gt(best.normalizedAmount)) {
        best = { asset, amountRaw, decimals, normalizedAmount };
      }
    }

    if (!best) {
      return undefined;
    }

    return {
      asset: this.getCanonicalAssetId(best.asset),
      amount: this.fromRawAmount(best.amountRaw.toString(), best.decimals),
    };
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

      const erc20Tokens = Array.from(this.decimalsCache.entries())
        .filter(([tokenAddress]) => tokenAddress !== NATIVE_TOKEN_ADDRESS)
        .map(([tokenAddress]) => tokenAddress as `0x${string}`);

      if (erc20Tokens.length > 0) {
        try {
          const erc20Balances = await this.signer.readErc20Balances(erc20Tokens, address);
          for (const result of erc20Balances) {
            const tokenAddress = this.normalizeAssetId(result.tokenAddress);
            const decimals = this.decimalsCache.get(tokenAddress);
            if (result.error) {
              console.warn(`[1inch] Failed to read ERC-20 balance for ${tokenAddress}: ${result.error.message}`);
              continue;
            }
            if (decimals === undefined || result.balance === undefined || result.balance <= 0n) {
              continue;
            }

            balances.push({
              asset: this.getCanonicalAssetId(tokenAddress),
              amount: quantity(this.fromRawAmount(result.balance.toString(), decimals)),
            });
          }
        } catch (multicallErr) {
          // Transport-level failure — fall back to individual per-token reads so
          // balances aren't permanently missing on providers without multicall support.
          console.warn(`[1inch] Multicall failed, falling back to per-token reads: ${multicallErr instanceof Error ? multicallErr.message : String(multicallErr)}`);
          for (const tokenAddress of erc20Tokens) {
            const normalized = this.normalizeAssetId(tokenAddress);
            const decimals = this.decimalsCache.get(normalized);
            if (decimals === undefined) continue;
            try {
              const balance = await this.signer.readErc20Balance(tokenAddress, address);
              if (balance > 0n) {
                balances.push({
                  asset: this.getCanonicalAssetId(normalized),
                  amount: quantity(this.fromRawAmount(balance.toString(), decimals)),
                });
              }
            } catch (tokenErr) {
              console.warn(`[1inch] Failed to read ERC-20 balance for ${normalized}: ${tokenErr instanceof Error ? tokenErr.message : String(tokenErr)}`);
            }
          }
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
      const normalizedAddress = this.normalizeAssetId(address);

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

      const txMap = new Map<string, ParsedTransferGroup>();
      const seenLogs = new Set<string>();
      for (const log of [...sentLogs, ...receivedLogs]) {
        const txHash = log.transactionHash;
        if (!txHash) {
          continue;
        }

        const dedupeKey = `${txHash}:${String(log.logIndex ?? 'unknown')}`;
        if (seenLogs.has(dedupeKey)) {
          continue;
        }
        seenLogs.add(dedupeKey);

        const transferArgs = log.args as {
          from?: `0x${string}`;
          to?: `0x${string}`;
          value?: bigint;
        } | undefined;
        const value = transferArgs?.value;
        if (value === undefined) {
          continue;
        }

        const group = txMap.get(txHash) ?? {
          blockNumber: log.blockNumber ?? undefined,
          sent: new Map<string, bigint>(),
          received: new Map<string, bigint>(),
          counterparties: new Set<string>(),
        };
        if (group.blockNumber === undefined && log.blockNumber !== null) {
          group.blockNumber = log.blockNumber ?? undefined;
        }

        const asset = this.rememberAssetId(log.address);
        const from = transferArgs?.from ? this.normalizeAssetId(transferArgs.from) : undefined;
        const to = transferArgs?.to ? this.normalizeAssetId(transferArgs.to) : undefined;
        if (from === normalizedAddress) {
          this.addTransferAmount(group.sent, asset, value);
          if (to) group.counterparties.add(to);
        }
        if (to === normalizedAddress) {
          this.addTransferAmount(group.received, asset, value);
          if (from) group.counterparties.add(from);
        }

        txMap.set(txHash, group);
      }

      await Promise.all(Array.from(txMap.entries()).map(async ([txHash, group]) => {
        if (group.sent.size > 0) {
          return;
        }

        const transaction = await publicClient.getTransaction({ hash: txHash as `0x${string}` });
        if (this.normalizeAssetId(transaction.from) === normalizedAddress && transaction.value > 0n) {
          this.addTransferAmount(group.sent, NATIVE_TOKEN_ADDRESS, transaction.value);
          if (transaction.to) {
            group.counterparties.add(this.normalizeAssetId(transaction.to));
          }
        }
      }));

      const blockNumbers = Array.from(new Set(
        Array.from(txMap.values())
          .map((group) => group.blockNumber)
          .filter((blockNumber): blockNumber is bigint => blockNumber !== undefined),
      ));
      const blockTimestamps = new Map<bigint, string>();

      await Promise.all(blockNumbers.map(async (blockNumber) => {
        const block = await publicClient.getBlock({ blockNumber });
        blockTimestamps.set(blockNumber, new Date(Number(block.timestamp) * 1000).toISOString());
      }));

      const txs: SwapTransaction[] = [];
      for (const [txHash, group] of txMap.entries()) {
        // When routerAddress is configured, only include transactions where a
        // Transfer counterparty matches the router. This filters out LP deposits,
        // staking wrappers, and other bidirectional flows unrelated to 1inch.
        if (this.routerAddress && !group.counterparties.has(this.routerAddress)) {
          continue;
        }

        const inputTransfer = await this.pickDominantTransfer(group.sent);
        const outputTransfer = await this.pickDominantTransfer(group.received);
        // Require both sides present — a real swap sends one asset and receives another.
        // Plain deposits/withdrawals/airdrops only have one side and should be excluded.
        // NOTE: ERC20→native swaps (e.g. USDC→ETH) will be excluded here because native
        // ETH receipt produces no Transfer event. Detecting native output requires trace
        // API support (debug_traceTransaction) which is not universally available.
        if (!inputTransfer || !outputTransfer) {
          continue;
        }

        const timestamp = group.blockNumber
          ? blockTimestamps.get(group.blockNumber) ?? new Date().toISOString()
          : new Date().toISOString();
        if (since && new Date(timestamp).getTime() < since.getTime()) {
          continue;
        }

        txs.push({
          executionRef: txHash,
          inputAsset: inputTransfer?.asset ?? 'unknown',
          outputAsset: outputTransfer?.asset ?? 'unknown',
          inputAmount: quantity(inputTransfer?.amount ?? '0'),
          outputAmount: quantity(outputTransfer?.amount ?? '0'),
          timestamp,
        });
      }

      txs.sort((left, right) => right.timestamp.localeCompare(left.timestamp));
      return ok(txs);
    } catch (error) {
      return err({ code: 'TX_ERROR', message: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Probe 1inch to return a static VenueProfile.
   * Authenticated is determined by whether a linked credential is present;
   * the caller signals this via the `hasCredential` flag.
   *
   * Note: availableSymbols is intentionally empty because 1inch supports any
   * EVM token pair and the specific chain is only known from the credential/config
   * at runtime. Instrument selection must be done manually (Advanced mode).
   */
  static probe(hasCredential = false): VenueProfile {
    return {
      venue: '1inch',
      venueType: 'swap',
      availableSymbols: [],
      supportedExecutionModes: hasCredential ? ['shadow', 'live'] : ['shadow'],
      authenticated: hasCredential,
      probedAt: new Date().toISOString(),
    };
  }
}
