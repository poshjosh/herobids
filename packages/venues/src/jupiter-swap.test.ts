import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { quantity } from '@herobids/domain';
import { JupiterSwapAdapter } from './jupiter-swap.js';
import type { SolanaSignerPort } from './solana-signer.js';
import { ok, err } from '@herobids/domain';

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const originalFetch = globalThis.fetch;

function makeMockSigner(overrides?: Partial<SolanaSignerPort>): SolanaSignerPort {
  return {
    address: 'test-wallet-address-base58',
    signAndSendTransaction: vi.fn().mockResolvedValue(ok({ signature: 'sig-abc123', slot: 100 })),
    getTransactionStatus: vi.fn().mockResolvedValue(ok({ confirmed: true, slot: 100 })),
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createAdapter(overrides?: Partial<ConstructorParameters<typeof JupiterSwapAdapter>[0]>): JupiterSwapAdapter {
  return new JupiterSwapAdapter({
    walletAddress: 'test-wallet-address-base58',
    apiUrl: 'https://quote-api.jup.ag/v6',
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    tokenDecimals: {
      [SOL_MINT]: 9,
      [USDC_MINT]: 6,
    },
    ...overrides,
  });
}

describe('JupiterSwapAdapter.quote', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns a quote with human-readable amounts on success', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      inputMint: USDC_MINT,
      outputMint: SOL_MINT,
      inAmount: '100000000', // 100 USDC (6 decimals)
      outAmount: '666666666', // ~0.666... SOL (9 decimals)
      otherAmountThreshold: '650000000', // ~0.65 SOL minimum
      priceImpactPct: '0.12',
    }));

    const adapter = createAdapter();
    const result = await adapter.quote({
      inputAsset: USDC_MINT,
      outputAsset: SOL_MINT,
      amount: quantity('100'),
      slippageBps: 100,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.inputAsset).toBe(USDC_MINT);
    expect(result.data.outputAsset).toBe(SOL_MINT);
    expect(result.data.inputAmount.toString()).toBe('100');
    expect(result.data.expectedOutputAmount.toString()).toBe('0.666666666');
    expect(result.data.minimumOutputAmount.toString()).toBe('0.65');
    expect(result.data.priceImpact).toBeCloseTo(0.0012);
  });

  it('sends correct query parameters to Jupiter API', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      inputMint: USDC_MINT,
      outputMint: SOL_MINT,
      inAmount: '50000000',
      outAmount: '333333333',
      otherAmountThreshold: '330000000',
      priceImpactPct: '0.05',
    }));

    const adapter = createAdapter();
    await adapter.quote({
      inputAsset: USDC_MINT,
      outputAsset: SOL_MINT,
      amount: quantity('50'),
      slippageBps: 50,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe('/v6/quote');
    expect(calledUrl.searchParams.get('inputMint')).toBe(USDC_MINT);
    expect(calledUrl.searchParams.get('outputMint')).toBe(SOL_MINT);
    expect(calledUrl.searchParams.get('amount')).toBe('50000000'); // 50 USDC raw
    expect(calledUrl.searchParams.get('slippageBps')).toBe('50');
  });

  it('returns QUOTE_FAILED error on non-200 API response', async () => {
    fetchMock.mockResolvedValue(new Response('Rate limited', { status: 429 }));

    const adapter = createAdapter();
    const result = await adapter.quote({
      inputAsset: USDC_MINT,
      outputAsset: SOL_MINT,
      amount: quantity('100'),
      slippageBps: 100,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('QUOTE_FAILED');
    expect(result.error.message).toContain('429');
  });

  it('returns QUOTE_ERROR when token decimals are unknown', async () => {
    const adapter = createAdapter({ tokenDecimals: {} });
    const result = await adapter.quote({
      inputAsset: 'UNKNOWN_MINT',
      outputAsset: SOL_MINT,
      amount: quantity('100'),
      slippageBps: 100,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('QUOTE_ERROR');
    expect(result.error.message).toContain('Token decimals unknown');
  });

  it('returns QUOTE_ERROR on network timeout', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'));

    const adapter = createAdapter();
    const result = await adapter.quote({
      inputAsset: USDC_MINT,
      outputAsset: SOL_MINT,
      amount: quantity('100'),
      slippageBps: 100,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('QUOTE_ERROR');
    expect(result.error.message).toContain('aborted');
  });
});

describe('JupiterSwapAdapter.executeSwap', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const validQuote = {
    quoteData: { inputMint: USDC_MINT, outputMint: SOL_MINT, inAmount: '100000000', outAmount: '666666666' },
    inputAsset: USDC_MINT,
    outputAsset: SOL_MINT,
    inputAmount: quantity('100'),
    expectedOutputAmount: quantity('0.666666666'),
    minimumOutputAmount: quantity('0.65'),
    priceImpact: 0.001,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  };

  it('fails closed with SWAP_SIGNING_UNAVAILABLE when no signer is configured', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      swapTransaction: 'base64-encoded-tx',
      txid: 'expected-txid',
    }));

    const adapter = createAdapter({ signer: undefined });
    const result = await adapter.executeSwap(validQuote);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SWAP_SIGNING_UNAVAILABLE');
    expect(result.error.message).toContain('No Solana signer configured');
  });

  it('returns receipt with execution ref on successful signing', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      swapTransaction: 'base64-encoded-tx-data',
    }));

    const signer = makeMockSigner();
    const adapter = createAdapter({ signer });
    const result = await adapter.executeSwap(validQuote);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.executionRef).toBe('sig-abc123');
    expect(result.data.inputAmount.toString()).toBe('100');
    expect(result.data.outputAmount.toString()).toBe('0.666666666');
    expect(signer.signAndSendTransaction).toHaveBeenCalledWith('base64-encoded-tx-data');
  });

  it('propagates signer failure as SWAP_TX_FAILED', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      swapTransaction: 'base64-encoded-tx-data',
    }));

    const signer = makeMockSigner({
      signAndSendTransaction: vi.fn().mockResolvedValue(
        err({ code: 'SEND_FAILED', message: 'Transaction simulation failed: insufficient funds' }),
      ),
    });
    const adapter = createAdapter({ signer });
    const result = await adapter.executeSwap(validQuote);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SWAP_TX_FAILED');
    expect(result.error.message).toContain('insufficient funds');
  });

  it('returns SWAP_FAILED when Jupiter swap API returns non-200', async () => {
    fetchMock.mockResolvedValue(new Response('Server error', { status: 500 }));

    const signer = makeMockSigner();
    const adapter = createAdapter({ signer });
    const result = await adapter.executeSwap(validQuote);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SWAP_FAILED');
    expect(result.error.message).toContain('500');
  });

  it('returns SWAP_ERROR on network failure', async () => {
    fetchMock.mockRejectedValue(new Error('Connection refused'));

    const signer = makeMockSigner();
    const adapter = createAdapter({ signer });
    const result = await adapter.executeSwap(validQuote);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SWAP_ERROR');
    expect(result.error.message).toContain('Connection refused');
  });

  it('sends correct POST body with quoteResponse and wallet', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ swapTransaction: 'tx-data' }));

    const signer = makeMockSigner();
    const adapter = createAdapter({ signer });
    await adapter.executeSwap(validQuote);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/swap');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body as string);
    expect(body.quoteResponse).toEqual(validQuote.quoteData);
    expect(body.userPublicKey).toBe('test-wallet-address-base58');
  });
});

describe('JupiterSwapAdapter.fetchBalances', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns SPL token balances and native SOL merged into WSOL', async () => {
    const WSOL_MINT = 'So11111111111111111111111111111111111111112';
    // First call: getTokenAccountsByOwner, second call: getBalance
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        result: {
          value: [
            {
              account: {
                data: { parsed: { info: { mint: USDC_MINT, tokenAmount: { uiAmountString: '250.5' } } } },
              },
            },
            {
              account: {
                data: { parsed: { info: { mint: WSOL_MINT, tokenAmount: { uiAmountString: '0.1' } } } },
              },
            },
          ],
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        result: { value: 2_000_000_000 }, // 2 SOL in lamports
      }));

    const adapter = createAdapter();
    const result = await adapter.fetchBalances();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.balances).toHaveLength(2);

    const usdcBalance = result.data.balances.find(b => b.asset === USDC_MINT);
    expect(usdcBalance?.amount.toString()).toBe('250.5');

    // WSOL balance (0.1 existing + 2 native SOL = 2.1)
    const solBalance = result.data.balances.find(b => b.asset === WSOL_MINT);
    expect(solBalance?.amount.toString()).toBe('2.1');
  });

  it('returns native SOL as WSOL when no wrapped SOL token account exists', async () => {
    const WSOL_MINT = 'So11111111111111111111111111111111111111112';
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ result: { value: [] } }))
      .mockResolvedValueOnce(jsonResponse({ result: { value: 500_000_000 } })); // 0.5 SOL

    const adapter = createAdapter();
    const result = await adapter.fetchBalances();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.balances).toHaveLength(1);
    expect(result.data.balances[0]!.asset).toBe(WSOL_MINT);
    expect(result.data.balances[0]!.amount.toString()).toBe('0.5');
  });

  it('returns BALANCE_FETCH_FAILED on RPC error', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('', { status: 503 }));

    const adapter = createAdapter();
    const result = await adapter.fetchBalances();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('BALANCE_FETCH_FAILED');
  });
});

describe('JupiterSwapAdapter.fetchRecentTransactions', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns parsed transactions filtered by since timestamp', async () => {
    const now = Math.floor(Date.now() / 1000);
    fetchMock.mockResolvedValue(jsonResponse({
      result: [
        { signature: 'tx-1', blockTime: now - 60 },   // 1 min ago — included
        { signature: 'tx-2', blockTime: now - 3700 },  // over 1 hour ago — excluded
      ],
    }));

    const adapter = createAdapter();
    const since = new Date((now - 3600) * 1000); // 1 hour ago
    const result = await adapter.fetchRecentTransactions(since);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.executionRef).toBe('tx-1');
  });

  it('returns TX_FETCH_FAILED on RPC error', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 500 }));

    const adapter = createAdapter();
    const result = await adapter.fetchRecentTransactions();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('TX_FETCH_FAILED');
  });
});

describe('JupiterSwapAdapter.probe', () => {
  it('returns paper mode only when no wallet is configured', async () => {
    const profile = await JupiterSwapAdapter.probe(undefined);
    expect(profile.venue).toBe('jupiter');
    expect(profile.venueType).toBe('swap');
    expect(profile.supportedExecutionModes).toEqual(['paper']);
    expect(profile.authenticated).toBe(false);
  });

  it('returns all modes when wallet address is present', async () => {
    const profile = await JupiterSwapAdapter.probe('7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU');
    expect(profile.supportedExecutionModes).toEqual(['paper', 'shadow', 'live']);
    expect(profile.authenticated).toBe(true);
  });
});
