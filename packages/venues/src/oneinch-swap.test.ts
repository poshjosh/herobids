import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { quantity, Decimal } from '@herobids/domain';
import { OneInchSwapAdapter } from './oneinch-swap.js';

const signerState = vi.hoisted(() => ({
  address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as `0x${string}`,
  sendTransaction: vi.fn(),
  readErc20Balance: vi.fn(),
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
    },
    tokenDecimals: {
      [USDC_CONFIGURED]: 6,
      [WETH]: 18,
    },
    ...overrides,
  });
}

/**
 * Unit tests for OneInchSwapAdapter.
 * Tests raw amount conversions, quote parsing, and balance mapping.
 * Does NOT test network calls — those belong in integration tests.
 */
describe('OneInch raw amount conversion', () => {
  // Inline the same logic from the adapter for isolated testing
  function toRawAmount(amount: string, decimals: number): string {
    const d = new Decimal(amount);
    const fixed = d.toFixed(decimals, Decimal.ROUND_DOWN);
    const parts = fixed.split('.');
    const intPart = parts[0] ?? '0';
    const fracPart = (parts[1] ?? '').padEnd(decimals, '0').slice(0, decimals);
    return BigInt(intPart + fracPart).toString();
  }

  function fromRawAmount(raw: string, decimals: number): string {
    if (decimals === 0) return raw;
    const padded = raw.padStart(decimals + 1, '0');
    const intPart = padded.slice(0, padded.length - decimals);
    const fracPart = padded.slice(padded.length - decimals);
    return `${intPart}.${fracPart}`.replace(/\.?0+$/, '') || '0';
  }

  it('converts 1 USDC (6 decimals) to raw', () => {
    expect(toRawAmount('1', 6)).toBe('1000000');
  });

  it('converts 0.5 ETH (18 decimals) to raw', () => {
    expect(toRawAmount('0.5', 18)).toBe('500000000000000000');
  });

  it('converts 100 USDC to raw', () => {
    expect(toRawAmount('100', 6)).toBe('100000000');
  });

  it('truncates excess precision (does not round up)', () => {
    // 1.1234567 with 6 decimals → 1123456 (truncates the 7)
    expect(toRawAmount('1.1234567', 6)).toBe('1123456');
  });

  it('converts raw 1000000 (6 decimals) to human-readable', () => {
    expect(fromRawAmount('1000000', 6)).toBe('1');
  });

  it('converts raw 500000000000000000 (18 decimals) to human-readable', () => {
    expect(fromRawAmount('500000000000000000', 18)).toBe('0.5');
  });

  it('converts raw 0 to "0"', () => {
    expect(fromRawAmount('0', 6)).toBe('0');
  });

  it('handles 0-decimal tokens', () => {
    expect(toRawAmount('42', 0)).toBe('42');
    expect(fromRawAmount('42', 0)).toBe('42');
  });

  it('handles large amounts without precision loss', () => {
    expect(toRawAmount('1000000', 18)).toBe('1000000000000000000000000');
    expect(fromRawAmount('1000000000000000000000000', 18)).toBe('1000000');
  });
});

describe('OneInch adapter behavior', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;

    signerState.sendTransaction.mockReset();
    signerState.readErc20Balance.mockReset();
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

  it('preserves configured asset ids when reporting balances', async () => {
    signerState.readErc20Balance.mockResolvedValue(2_500_000n);

    const adapter = createAdapter({ tokenDecimals: { [USDC_CONFIGURED]: 6 } });
    const result = await adapter.fetchBalances();

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected balances to succeed');
    expect(result.data.balances).toEqual([
      { asset: USDC_CONFIGURED, amount: quantity('2.5') },
    ]);
    expect(signerState.readErc20Balance).toHaveBeenCalledTimes(1);
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
});

describe('OneInch quote response parsing', () => {
  it('computes slippage-adjusted minimum output', () => {
    const expectedOutput = '100';
    const slippageBps = 50; // 0.5%
    const slippageMultiplier = new Decimal(1).minus(new Decimal(slippageBps).div(10_000));
    const minimumOutput = new Decimal(expectedOutput).mul(slippageMultiplier).toFixed(6, Decimal.ROUND_DOWN);
    expect(minimumOutput).toBe('99.500000');
  });

  it('handles high slippage (5%)', () => {
    const expectedOutput = '1000';
    const slippageBps = 500;
    const slippageMultiplier = new Decimal(1).minus(new Decimal(slippageBps).div(10_000));
    const minimumOutput = new Decimal(expectedOutput).mul(slippageMultiplier).toFixed(6, Decimal.ROUND_DOWN);
    expect(minimumOutput).toBe('950.000000');
  });

  it('handles zero slippage', () => {
    const expectedOutput = '50.123456';
    const slippageBps = 0;
    const slippageMultiplier = new Decimal(1).minus(new Decimal(slippageBps).div(10_000));
    const minimumOutput = new Decimal(expectedOutput).mul(slippageMultiplier).toFixed(6, Decimal.ROUND_DOWN);
    expect(minimumOutput).toBe('50.123456');
  });
});

describe('OneInch balance mapping', () => {
  it('constructs balance entry from raw token balance and decimals', () => {
    const rawBalance = '2500000'; // 2.5 USDC (6 decimals)
    const decimals = 6;
    const padded = rawBalance.padStart(decimals + 1, '0');
    const intPart = padded.slice(0, padded.length - decimals);
    const fracPart = padded.slice(padded.length - decimals);
    const humanAmount = `${intPart}.${fracPart}`.replace(/\.?0+$/, '') || '0';

    const balance = { asset: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', amount: quantity(humanAmount) };
    expect(balance.amount.toString()).toBe('2.5');
  });

  it('maps native ETH balance (18 decimals)', () => {
    const rawBalance = '1000000000000000000'; // 1 ETH
    const decimals = 18;
    const padded = rawBalance.padStart(decimals + 1, '0');
    const intPart = padded.slice(0, padded.length - decimals);
    const fracPart = padded.slice(padded.length - decimals);
    const humanAmount = `${intPart}.${fracPart}`.replace(/\.?0+$/, '') || '0';

    expect(humanAmount).toBe('1');
  });
});
