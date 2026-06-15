import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { quantity } from '@herobids/domain';
import { OneInchSwapAdapter } from './oneinch-swap.js';

const signerState = vi.hoisted(() => ({
  address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as `0x${string}`,
  sendTransaction: vi.fn(),
  readErc20Balance: vi.fn(),
  readErc20Balances: vi.fn(),
  readErc20Allowance: vi.fn(),
  readErc20Decimals: vi.fn(),
  approveErc20: vi.fn(),
  readNativeBalance: vi.fn(),
  getPublicClient: vi.fn(),
}));

vi.mock('./evm-signer.js', () => {
  class MockEvmSigner {
    constructor(_config: unknown) {}

    get address(): `0x${string}` {
      return signerState.address;
    }

    sendTransaction = signerState.sendTransaction;
    readErc20Balance = signerState.readErc20Balance;
    readErc20Balances = signerState.readErc20Balances;
    readErc20Allowance = signerState.readErc20Allowance;
    readErc20Decimals = signerState.readErc20Decimals;
    approveErc20 = signerState.approveErc20;
    readNativeBalance = signerState.readNativeBalance;
    getPublicClient = signerState.getPublicClient;
  }

  return { EvmSigner: MockEvmSigner };
});

const USDC_CONFIGURED = '0x833589fCd6eDb6E08f4C7c32D4f71b54bdA02913';
const USDC_LOWER = USDC_CONFIGURED.toLowerCase();
const WETH = '0x4200000000000000000000000000000000000006';
const ONEINCH_SPENDER = '0x111111125421ca6dc452d289314280a0f8842a65';
const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createAdapter(overrides?: Partial<ConstructorParameters<typeof OneInchSwapAdapter>[0]>): OneInchSwapAdapter {
  return new OneInchSwapAdapter({
    apiUrl: 'https://api.1inch.dev/swap/v6.0/8453',
    apiKey: 'test-api-key',
    signer: {
      privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      rpcUrl: 'https://mainnet.base.org',
      chainId: 8453,
      confirmationTimeoutMs: 60_000,
    },
    tokenDecimals: {
      [USDC_CONFIGURED]: 6,
      [WETH]: 18,
    },
    ...overrides,
  });
}

describe('OneInch adapter behavior', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    signerState.sendTransaction.mockReset();
    signerState.readErc20Balance.mockReset();
    signerState.readErc20Balances.mockReset();
    signerState.readErc20Allowance.mockReset();
    signerState.readErc20Decimals.mockReset();
    signerState.approveErc20.mockReset();
    signerState.readNativeBalance.mockReset();
    signerState.getPublicClient.mockReset();

    signerState.sendTransaction.mockResolvedValue({
      ok: true,
      data: { transactionHash: '0xswaphash', gasUsed: 45_678n },
    });
    signerState.readErc20Balance.mockResolvedValue(0n);
    signerState.readErc20Balances.mockResolvedValue([]);
    signerState.readErc20Allowance.mockResolvedValue(0n);
    signerState.readErc20Decimals.mockResolvedValue(6);
    signerState.approveErc20.mockResolvedValue({
      ok: true,
      data: { transactionHash: '0xapprovehash', gasUsed: 21_000n },
    });
    signerState.readNativeBalance.mockResolvedValue(0n);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('reuses configured decimals when quote asset casing differs', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({
      srcToken: { address: USDC_LOWER },
      dstToken: { address: WETH },
      toAmount: '5000000000000000',
    })));

    const adapter = createAdapter();
    const result = await adapter.quote({
      inputAsset: USDC_LOWER,
      outputAsset: WETH,
      amount: quantity('1'),
      slippageBps: 100,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected quote to succeed');
    expect(result.data.inputAsset).toBe(USDC_CONFIGURED);
    expect(signerState.readErc20Decimals).not.toHaveBeenCalled();
  });

  it('converts human-readable quote inputs to raw units and returns scaled outputs', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      srcToken: { address: USDC_CONFIGURED },
      dstToken: { address: WETH },
      toAmount: '500000000000000000',
    }));

    const adapter = createAdapter();
    const result = await adapter.quote({
      inputAsset: USDC_CONFIGURED,
      outputAsset: WETH,
      amount: quantity('100'),
      slippageBps: 50,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe('/swap/v6.0/8453/quote');
    expect(calledUrl.searchParams.get('src')).toBe(USDC_CONFIGURED);
    expect(calledUrl.searchParams.get('dst')).toBe(WETH);
    expect(calledUrl.searchParams.get('amount')).toBe('100000000');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected quote to succeed');
    expect(result.data.inputAmount.toString()).toBe('100');
    expect(result.data.expectedOutputAmount.toString()).toBe('0.5');
    expect(result.data.minimumOutputAmount.toString()).toBe('0.4975');
  });

  it('normalizes inputAmount to executable precision (truncates excess decimals)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      srcToken: { address: USDC_CONFIGURED },
      dstToken: { address: WETH },
      toAmount: '500000000000000000',
    }));

    const adapter = createAdapter();
    const result = await adapter.quote({
      inputAsset: USDC_CONFIGURED,
      outputAsset: WETH,
      amount: quantity('1.1234567'), // 7 fractional digits, USDC has 6
      slippageBps: 50,
    });

    // Verify the on-wire amount is truncated
    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.searchParams.get('amount')).toBe('1123456'); // truncated to 6 decimals

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected quote to succeed');
    // inputAmount must match the executable (truncated) value, not the original
    expect(result.data.inputAmount.toString()).toBe('1.123456');
  });

  it('truncates fractional amounts to zero for zero-decimal assets', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      srcToken: { address: 'POINTS' },
      dstToken: { address: USDC_CONFIGURED },
      toAmount: '2500000',
    }));

    const adapter = createAdapter({
      tokenDecimals: {
        POINTS: 0,
        [USDC_CONFIGURED]: 6,
      },
    });

    const result = await adapter.quote({
      inputAsset: 'POINTS',
      outputAsset: USDC_CONFIGURED,
      amount: quantity('42.9'),
      slippageBps: 0,
    });

    // On-wire amount should be the truncated integer
    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.searchParams.get('amount')).toBe('42');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected quote to succeed');
    expect(result.data.inputAmount.toString()).toBe('42');
  });

  it('returns QUOTE_FAILED on non-200 quote response', async () => {
    fetchMock.mockResolvedValue(new Response('Rate limited', { status: 429 }));

    const adapter = createAdapter();
    const result = await adapter.quote({
      inputAsset: USDC_CONFIGURED,
      outputAsset: WETH,
      amount: quantity('1'),
      slippageBps: 100,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected quote to fail');
    expect(result.error.code).toBe('QUOTE_FAILED');
    expect(result.error.message).toContain('429');
  });

  it('returns QUOTE_ERROR on aborted quote request', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'));

    const adapter = createAdapter();
    const result = await adapter.quote({
      inputAsset: USDC_CONFIGURED,
      outputAsset: WETH,
      amount: quantity('1'),
      slippageBps: 100,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected quote to fail');
    expect(result.error.code).toBe('QUOTE_ERROR');
    expect(result.error.message).toContain('aborted');
  });

  it('preserves configured asset ids when reporting balances', async () => {
    signerState.readErc20Balances.mockResolvedValue([
      { tokenAddress: USDC_LOWER, balance: 2_500_000n },
    ]);

    const adapter = createAdapter({ tokenDecimals: { [USDC_CONFIGURED]: 6 } });
    const result = await adapter.fetchBalances();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected balances to succeed');
    expect(result.data.balances).toEqual([
      { asset: USDC_CONFIGURED, amount: quantity('2.5') },
    ]);
    expect(signerState.readErc20Balances).toHaveBeenCalledTimes(1);
  });

  it('approves ERC-20 input before swap when allowance is insufficient', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({
      tx: {
        to: ONEINCH_SPENDER,
        data: '0xabcdef',
        value: '0',
        gas: 210000,
      },
      toAmount: '5000000000000000',
    })));

    const adapter = createAdapter();
    const result = await adapter.executeSwap({
      quoteData: { _slippageBps: 100 },
      inputAsset: USDC_CONFIGURED,
      outputAsset: WETH,
      inputAmount: quantity('1'),
      expectedOutputAmount: quantity('0.005'),
      minimumOutputAmount: quantity('0.00495'),
      priceImpact: 0,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });

    expect(result.ok).toBe(true);
    expect(signerState.readErc20Allowance).toHaveBeenCalledWith(
      USDC_CONFIGURED,
      signerState.address,
      ONEINCH_SPENDER,
    );
    expect(signerState.approveErc20).toHaveBeenCalledWith(
      USDC_CONFIGURED,
      ONEINCH_SPENDER,
      1_000_000n,
    );
    expect(signerState.approveErc20.mock.invocationCallOrder[0]).toBeLessThan(
      signerState.sendTransaction.mock.invocationCallOrder[0],
    );
  });

  it('executeSwap truncates excess-precision inputAmount consistently with quote()', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({
      tx: { to: ONEINCH_SPENDER, data: '0xabcdef', value: '0', gas: 210000 },
      toAmount: '5000000000000000',
    })));

    const adapter = createAdapter();
    const result = await adapter.executeSwap({
      quoteData: { _slippageBps: 100 },
      inputAsset: USDC_CONFIGURED,
      outputAsset: WETH,
      inputAmount: quantity('1.1234567'), // excess precision — 7 digits, USDC has 6
      expectedOutputAmount: quantity('0.005'),
      minimumOutputAmount: quantity('0.00495'),
      priceImpact: 0,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });

    expect(result.ok).toBe(true);
    // The on-wire amount sent to 1inch must be truncated to 6 decimals
    const calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.searchParams.get('amount')).toBe('1123456');
  });

  it('applies the configured API rate limit', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({
      srcToken: { address: USDC_LOWER },
      dstToken: { address: WETH },
      toAmount: '5000000000000000',
    })));

    const adapter = createAdapter({ rateLimitPerSec: 1 });

    await adapter.quote({
      inputAsset: USDC_CONFIGURED,
      outputAsset: WETH,
      amount: quantity('1'),
      slippageBps: 100,
    });

    const secondQuote = adapter.quote({
      inputAsset: USDC_CONFIGURED,
      outputAsset: WETH,
      amount: quantity('1'),
      slippageBps: 100,
    });

    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1001);
    await secondQuote;

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('parses ERC-20 transfers into recent swap transactions', async () => {
    const publicClient = {
      getBlockNumber: vi.fn().mockResolvedValue(1000n),
      getLogs: vi.fn()
        .mockResolvedValueOnce([
          {
            transactionHash: '0xtx1',
            address: USDC_LOWER,
            blockNumber: 999n,
            logIndex: 1,
            args: {
              from: signerState.address,
              to: ONEINCH_SPENDER,
              value: 1_500_000n,
            },
          },
        ])
        .mockResolvedValueOnce([
          {
            transactionHash: '0xtx1',
            address: WETH,
            blockNumber: 999n,
            logIndex: 2,
            args: {
              from: ONEINCH_SPENDER,
              to: signerState.address,
              value: 750_000_000_000_000n,
            },
          },
        ]),
      getBlock: vi.fn().mockResolvedValue({ timestamp: 1_717_156_800n }),
      getTransaction: vi.fn(),
    };
    signerState.getPublicClient.mockReturnValue(publicClient);

    const adapter = createAdapter();
    const result = await adapter.fetchRecentTransactions(new Date('2024-05-31T00:00:00.000Z'));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected transactions to succeed');
    expect(result.data).toEqual([
      {
        executionRef: '0xtx1',
        inputAsset: USDC_CONFIGURED,
        outputAsset: WETH,
        inputAmount: quantity('1.5'),
        outputAmount: quantity('0.00075'),
        timestamp: '2024-05-31T12:00:00.000Z',
      },
    ]);
    expect(publicClient.getTransaction).not.toHaveBeenCalled();
  });

  it('falls back to native-token input when the swap sends value directly', async () => {
    const publicClient = {
      getBlockNumber: vi.fn().mockResolvedValue(1000n),
      getLogs: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            transactionHash: '0xtx2',
            address: USDC_LOWER,
            blockNumber: 998n,
            logIndex: 1,
            args: {
              from: ONEINCH_SPENDER,
              to: signerState.address,
              value: 2_500_000n,
            },
          },
        ]),
      getBlock: vi.fn().mockResolvedValue({ timestamp: 1_717_156_860n }),
      getTransaction: vi.fn().mockResolvedValue({
        from: signerState.address,
        value: 200_000_000_000_000_000n,
      }),
    };
    signerState.getPublicClient.mockReturnValue(publicClient);

    const adapter = createAdapter();
    const result = await adapter.fetchRecentTransactions(new Date('2024-05-31T00:00:00.000Z'));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected transactions to succeed');
    expect(result.data).toEqual([
      {
        executionRef: '0xtx2',
        inputAsset: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        outputAsset: USDC_CONFIGURED,
        inputAmount: quantity('0.2'),
        outputAmount: quantity('2.5'),
        timestamp: '2024-05-31T12:01:00.000Z',
      },
    ]);
    expect(publicClient.getTransaction).toHaveBeenCalledWith({ hash: '0xtx2' });
  });

  it('filters out transactions whose counterparties do not include the configured router', async () => {
    const LP_POOL = '0xdead000000000000000000000000000000000001';
    const publicClient = {
      getBlockNumber: vi.fn().mockResolvedValue(1000n),
      getLogs: vi.fn()
        .mockResolvedValueOnce([
          // tx1: swap via the 1inch router (counterparty = ONEINCH_SPENDER)
          {
            transactionHash: '0xtx1',
            address: USDC_LOWER,
            blockNumber: 999n,
            logIndex: 1,
            args: { from: signerState.address, to: ONEINCH_SPENDER, value: 1_000_000n },
          },
          // tx2: LP deposit to an unrelated pool (counterparty = LP_POOL)
          {
            transactionHash: '0xtx2',
            address: USDC_LOWER,
            blockNumber: 998n,
            logIndex: 3,
            args: { from: signerState.address, to: LP_POOL, value: 500_000n },
          },
        ])
        .mockResolvedValueOnce([
          // tx1 output from the router
          {
            transactionHash: '0xtx1',
            address: WETH,
            blockNumber: 999n,
            logIndex: 2,
            args: { from: ONEINCH_SPENDER, to: signerState.address, value: 400_000_000_000_000n },
          },
          // tx2 LP receipt from the pool
          {
            transactionHash: '0xtx2',
            address: WETH,
            blockNumber: 998n,
            logIndex: 4,
            args: { from: LP_POOL, to: signerState.address, value: 200_000_000_000_000n },
          },
        ]),
      getBlock: vi.fn().mockResolvedValue({ timestamp: 1_717_156_800n }),
      getTransaction: vi.fn(),
    };
    signerState.getPublicClient.mockReturnValue(publicClient);

    const adapter = createAdapter({ routerAddress: ONEINCH_SPENDER });
    const result = await adapter.fetchRecentTransactions(new Date('2024-05-31T00:00:00.000Z'));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    // Only tx1 (router counterparty) should be included; tx2 (LP pool) filtered out
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.executionRef).toBe('0xtx1');
  });
});

describe('OneInch approval-flow regression coverage', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    signerState.sendTransaction.mockReset();
    signerState.readErc20Balance.mockReset();
    signerState.readErc20Balances.mockReset();
    signerState.readErc20Allowance.mockReset();
    signerState.readErc20Decimals.mockReset();
    signerState.approveErc20.mockReset();
    signerState.readNativeBalance.mockReset();
    signerState.getPublicClient.mockReset();

    signerState.sendTransaction.mockResolvedValue({
      ok: true,
      data: { transactionHash: '0xswaphash', gasUsed: 45_678n },
    });
    signerState.readErc20Allowance.mockResolvedValue(0n);
    signerState.approveErc20.mockResolvedValue({
      ok: true,
      data: { transactionHash: '0xapprovehash', gasUsed: 21_000n },
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const makeSwapQuote = () => ({
    quoteData: { _slippageBps: 100 },
    inputAsset: USDC_CONFIGURED,
    outputAsset: WETH,
    inputAmount: quantity('10'),
    expectedOutputAmount: quantity('0.005'),
    minimumOutputAmount: quantity('0.00495'),
    priceImpact: 0,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  });

  it('skips approval when existing allowance is sufficient', async () => {
    signerState.readErc20Allowance.mockResolvedValue(100_000_000n); // 100 USDC (well above 10)

    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({
      tx: { to: ONEINCH_SPENDER, data: '0xabcdef', value: '0', gas: 210000 },
      toAmount: '5000000000000000',
    })));

    const adapter = createAdapter();
    const result = await adapter.executeSwap(makeSwapQuote());

    expect(result.ok).toBe(true);
    expect(signerState.approveErc20).not.toHaveBeenCalled();
  });

  it('re-approves when the fresh swap calldata returns a different spender', async () => {
    const FIRST_SPENDER = '0x111111125421ca6dc452d289314280a0f8842a65';
    const SECOND_SPENDER = '0x222222125421ca6dc452d289314280a0f8842a65';

    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        tx: { to: FIRST_SPENDER, data: '0xspender1', value: '0', gas: 210000 },
        toAmount: '5000000000000000',
      }))
      .mockResolvedValueOnce(jsonResponse({
        tx: { to: SECOND_SPENDER, data: '0xspender2', value: '0', gas: 210000 },
        toAmount: '5000000000000000',
      }));

    const adapter = createAdapter();
    const result = await adapter.executeSwap(makeSwapQuote());

    expect(result.ok).toBe(true);
    expect(signerState.approveErc20).toHaveBeenCalledTimes(2);
    expect(signerState.approveErc20).toHaveBeenNthCalledWith(1, USDC_CONFIGURED, FIRST_SPENDER, 10_000_000n);
    expect(signerState.approveErc20).toHaveBeenNthCalledWith(2, USDC_CONFIGURED, SECOND_SPENDER, 10_000_000n);
    expect(signerState.sendTransaction).toHaveBeenCalledWith(expect.objectContaining({ to: SECOND_SPENDER }));
  });

  it('performs zero-reset then re-approves when first approval reverts with existing non-zero allowance', async () => {
    // Existing non-zero allowance but smaller than required
    signerState.readErc20Allowance.mockResolvedValue(5_000_000n); // 5 USDC
    // First approval fails with tx_reverted (simulates non-zero-to-non-zero restriction)
    signerState.approveErc20
      .mockResolvedValueOnce({ ok: false, error: { code: 'evm.tx_reverted', message: 'approve reverted' } })
      // Zero-reset succeeds
      .mockResolvedValueOnce({ ok: true, data: { transactionHash: '0xreset', gasUsed: 21_000n } })
      // Re-approve succeeds
      .mockResolvedValueOnce({ ok: true, data: { transactionHash: '0xapprove2', gasUsed: 21_000n } });

    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({
      tx: { to: ONEINCH_SPENDER, data: '0xabcdef', value: '0', gas: 210000 },
      toAmount: '5000000000000000',
    })));

    const adapter = createAdapter();
    const result = await adapter.executeSwap(makeSwapQuote());

    expect(result.ok).toBe(true);
    // First: approve 10M (fails), second: reset to 0, third: re-approve 10M
    expect(signerState.approveErc20).toHaveBeenCalledTimes(3);
    expect(signerState.approveErc20).toHaveBeenNthCalledWith(1, USDC_CONFIGURED, ONEINCH_SPENDER, 10_000_000n);
    expect(signerState.approveErc20).toHaveBeenNthCalledWith(2, USDC_CONFIGURED, ONEINCH_SPENDER, 0n);
    expect(signerState.approveErc20).toHaveBeenNthCalledWith(3, USDC_CONFIGURED, ONEINCH_SPENDER, 10_000_000n);
  });

  it('fails closed when zero-reset itself fails', async () => {
    signerState.readErc20Allowance.mockResolvedValue(5_000_000n);
    signerState.approveErc20
      .mockResolvedValueOnce({ ok: false, error: { code: 'evm.tx_reverted', message: 'approve reverted' } })
      // Zero-reset also fails
      .mockResolvedValueOnce({ ok: false, error: { code: 'evm.tx_reverted', message: 'reset failed' } });

    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({
      tx: { to: ONEINCH_SPENDER, data: '0xabcdef', value: '0', gas: 210000 },
      toAmount: '5000000000000000',
    })));

    const adapter = createAdapter();
    const result = await adapter.executeSwap(makeSwapQuote());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SWAP_ERROR');
    expect(result.error.message).toContain('Failed to reset allowance');
  });

  it('fails closed when re-approve after reset also fails', async () => {
    signerState.readErc20Allowance.mockResolvedValue(5_000_000n);
    signerState.approveErc20
      .mockResolvedValueOnce({ ok: false, error: { code: 'evm.tx_reverted', message: 'approve reverted' } })
      .mockResolvedValueOnce({ ok: true, data: { transactionHash: '0xreset', gasUsed: 21_000n } })
      // Re-approve fails
      .mockResolvedValueOnce({ ok: false, error: { code: 'evm.tx_reverted', message: 'still failing' } });

    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({
      tx: { to: ONEINCH_SPENDER, data: '0xabcdef', value: '0', gas: 210000 },
      toAmount: '5000000000000000',
    })));

    const adapter = createAdapter();
    const result = await adapter.executeSwap(makeSwapQuote());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SWAP_ERROR');
    expect(result.error.message).toContain('Failed to approve');
  });

  it('does not attempt zero-reset on transient failure without existing allowance', async () => {
    // No existing allowance
    signerState.readErc20Allowance.mockResolvedValue(0n);
    // Approval fails with non-revert error (transient)
    signerState.approveErc20
      .mockResolvedValueOnce({ ok: false, error: { code: 'evm.rpc_timeout', message: 'RPC timeout' } });

    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({
      tx: { to: ONEINCH_SPENDER, data: '0xabcdef', value: '0', gas: 210000 },
      toAmount: '5000000000000000',
    })));

    const adapter = createAdapter();
    const result = await adapter.executeSwap(makeSwapQuote());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('SWAP_ERROR');
    expect(result.error.message).toContain('Failed to approve');
    // Only one approval attempt — no zero-reset because allowance was 0
    expect(signerState.approveErc20).toHaveBeenCalledTimes(1);
  });

  it('does not attempt zero-reset on non-revert error even with existing allowance', async () => {
    // Existing non-zero allowance
    signerState.readErc20Allowance.mockResolvedValue(5_000_000n);
    // Transient RPC failure — NOT a tx_reverted code
    signerState.approveErc20
      .mockResolvedValueOnce({ ok: false, error: { code: 'evm.rpc_timeout', message: 'timeout' } });

    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({
      tx: { to: ONEINCH_SPENDER, data: '0xabcdef', value: '0', gas: 210000 },
      toAmount: '5000000000000000',
    })));

    const adapter = createAdapter();
    const result = await adapter.executeSwap(makeSwapQuote());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Should fail without attempting zero-reset (only tx_reverted triggers reset path)
    expect(signerState.approveErc20).toHaveBeenCalledTimes(1);
  });

  it('skips approval entirely for native token (ETH) input', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({
      tx: { to: ONEINCH_SPENDER, data: '0xabcdef', value: '200000000000000000', gas: 210000 },
      toAmount: '5000000',
    })));

    const adapter = createAdapter();
    const result = await adapter.executeSwap({
      quoteData: { _slippageBps: 100 },
      inputAsset: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      outputAsset: USDC_CONFIGURED,
      inputAmount: quantity('0.2'),
      expectedOutputAmount: quantity('5'),
      minimumOutputAmount: quantity('4.95'),
      priceImpact: 0,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    });

    expect(result.ok).toBe(true);
    expect(signerState.readErc20Allowance).not.toHaveBeenCalled();
    expect(signerState.approveErc20).not.toHaveBeenCalled();
  });
});

describe('OneInch router-scoped transaction interpretation', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;
    signerState.getPublicClient.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('excludes transactions with no router counterparty when routerAddress is configured', async () => {
    const LP_POOL = '0xdead000000000000000000000000000000000002';
    const publicClient = {
      getBlockNumber: vi.fn().mockResolvedValue(1000n),
      getLogs: vi.fn()
        .mockResolvedValueOnce([
          // LP deposit — counterparty is LP_POOL, not router
          {
            transactionHash: '0xtx-lp',
            address: USDC_LOWER,
            blockNumber: 999n,
            logIndex: 1,
            args: { from: signerState.address, to: LP_POOL, value: 1_000_000n },
          },
        ])
        .mockResolvedValueOnce([
          // LP receipt
          {
            transactionHash: '0xtx-lp',
            address: WETH,
            blockNumber: 999n,
            logIndex: 2,
            args: { from: LP_POOL, to: signerState.address, value: 500_000_000_000_000n },
          },
        ]),
      getBlock: vi.fn().mockResolvedValue({ timestamp: 1_717_156_800n }),
      getTransaction: vi.fn(),
    };
    signerState.getPublicClient.mockReturnValue(publicClient);

    const adapter = createAdapter({ routerAddress: ONEINCH_SPENDER });
    const result = await adapter.fetchRecentTransactions(new Date('2024-05-31T00:00:00.000Z'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(0);
  });

  it('includes all bidirectional transfers when routerAddress is not configured', async () => {
    const SOME_ADDRESS = '0xaaaa000000000000000000000000000000000001';
    const publicClient = {
      getBlockNumber: vi.fn().mockResolvedValue(1000n),
      getLogs: vi.fn()
        .mockResolvedValueOnce([
          {
            transactionHash: '0xtx-other',
            address: USDC_LOWER,
            blockNumber: 999n,
            logIndex: 1,
            args: { from: signerState.address, to: SOME_ADDRESS, value: 2_000_000n },
          },
        ])
        .mockResolvedValueOnce([
          {
            transactionHash: '0xtx-other',
            address: WETH,
            blockNumber: 999n,
            logIndex: 2,
            args: { from: SOME_ADDRESS, to: signerState.address, value: 1_000_000_000_000_000n },
          },
        ]),
      getBlock: vi.fn().mockResolvedValue({ timestamp: 1_717_156_800n }),
      getTransaction: vi.fn(),
    };
    signerState.getPublicClient.mockReturnValue(publicClient);

    // No routerAddress → all bidirectional transfers are included
    const adapter = createAdapter({ routerAddress: undefined });
    const result = await adapter.fetchRecentTransactions(new Date('2024-05-31T00:00:00.000Z'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.executionRef).toBe('0xtx-other');
  });

  it('excludes one-sided transfers (deposits or withdrawals without both sides)', async () => {
    const publicClient = {
      getBlockNumber: vi.fn().mockResolvedValue(1000n),
      getLogs: vi.fn()
        .mockResolvedValueOnce([
          // Outgoing transfer only (no corresponding receive)
          {
            transactionHash: '0xtx-send',
            address: USDC_LOWER,
            blockNumber: 999n,
            logIndex: 1,
            args: { from: signerState.address, to: ONEINCH_SPENDER, value: 3_000_000n },
          },
        ])
        .mockResolvedValueOnce([]),
      getBlock: vi.fn().mockResolvedValue({ timestamp: 1_717_156_800n }),
      getTransaction: vi.fn(),
    };
    signerState.getPublicClient.mockReturnValue(publicClient);

    const adapter = createAdapter({ routerAddress: ONEINCH_SPENDER });
    const result = await adapter.fetchRecentTransactions(new Date('2024-05-31T00:00:00.000Z'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only one side (sent) → not a swap → excluded
    expect(result.data).toHaveLength(0);
  });

  it('correctly identifies dominant asset in multi-transfer transactions', async () => {
    // A swap with multiple token outputs — picks the dominant (largest) per side
    const BONUS_TOKEN = '0xbbbb000000000000000000000000000000000001';
    const publicClient = {
      getBlockNumber: vi.fn().mockResolvedValue(1000n),
      getLogs: vi.fn()
        .mockResolvedValueOnce([
          {
            transactionHash: '0xtx-multi',
            address: USDC_LOWER,
            blockNumber: 999n,
            logIndex: 1,
            args: { from: signerState.address, to: ONEINCH_SPENDER, value: 5_000_000n },
          },
        ])
        .mockResolvedValueOnce([
          // Main output: 2 WETH (18 decimals)
          {
            transactionHash: '0xtx-multi',
            address: WETH,
            blockNumber: 999n,
            logIndex: 2,
            args: { from: ONEINCH_SPENDER, to: signerState.address, value: 2_000_000_000_000_000_000n },
          },
          // Small bonus token (6 decimals, 0.001 value — smaller)
          {
            transactionHash: '0xtx-multi',
            address: BONUS_TOKEN,
            blockNumber: 999n,
            logIndex: 3,
            args: { from: ONEINCH_SPENDER, to: signerState.address, value: 1000n },
          },
        ]),
      getBlock: vi.fn().mockResolvedValue({ timestamp: 1_717_156_800n }),
      getTransaction: vi.fn(),
    };
    signerState.getPublicClient.mockReturnValue(publicClient);
    // Provide decimals for the bonus token
    signerState.readErc20Decimals.mockResolvedValue(6);

    const adapter = createAdapter({ routerAddress: ONEINCH_SPENDER, tokenDecimals: { [USDC_CONFIGURED]: 6, [WETH]: 18, [BONUS_TOKEN]: 6 } });
    const result = await adapter.fetchRecentTransactions(new Date('2024-05-31T00:00:00.000Z'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(1);
    // Output should be WETH (dominant = largest human-readable amount)
    expect(result.data[0]!.outputAsset).toBe(WETH);
    expect(result.data[0]!.outputAmount.toString()).toBe('2');
    expect(result.data[0]!.inputAsset).toBe(USDC_CONFIGURED);
    expect(result.data[0]!.inputAmount.toString()).toBe('5');
  });
});

