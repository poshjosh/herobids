import { describe, it, expect, vi, afterEach } from 'vitest';
import { EvmConfirmationPoller } from './evm-confirmation.js';

describe('EvmConfirmationPoller', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns confirmed: true for successful transaction receipt', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { status: '0x1', blockNumber: '0xa' },
    }), { status: 200 }));

    const poller = new EvmConfirmationPoller({ rpcUrl: 'http://localhost:8545' });
    const result = await poller.checkConfirmation('0xabc123');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.confirmed).toBe(true);
    expect(result.data.blockNumber).toBe(10);
    expect(result.data.timestamp).toBeDefined();
  });

  it('returns confirmed: false and failed: true for reverted transaction', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { status: '0x0', blockNumber: '0xf' },
    }), { status: 200 }));

    const poller = new EvmConfirmationPoller({ rpcUrl: 'http://localhost:8545' });
    const result = await poller.checkConfirmation('0xdef456');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.confirmed).toBe(false);
    expect(result.data.failed).toBe(true);
    expect(result.data.blockNumber).toBe(15);
  });

  it('returns confirmed: false without failed for pending tx (null receipt)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: null,
    }), { status: 200 }));

    const poller = new EvmConfirmationPoller({ rpcUrl: 'http://localhost:8545' });
    const result = await poller.checkConfirmation('0xpending');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.confirmed).toBe(false);
  });

  it('returns error when RPC returns non-200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }));

    const poller = new EvmConfirmationPoller({ rpcUrl: 'http://localhost:8545' });
    const result = await poller.checkConfirmation('0xfail');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('RPC_ERROR');
  });

  it('returns error when RPC responds with JSON-RPC error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      error: { message: 'Method not found' },
    }), { status: 200 }));

    const poller = new EvmConfirmationPoller({ rpcUrl: 'http://localhost:8545' });
    const result = await poller.checkConfirmation('0xerror');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('RPC_ERROR');
    expect(result.error.message).toBe('Method not found');
  });

  it('returns error on timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      return new Promise((_, reject) => {
        const err = new Error('timeout');
        err.name = 'TimeoutError';
        reject(err);
      });
    });

    const poller = new EvmConfirmationPoller({ rpcUrl: 'http://localhost:8545', timeoutMs: 100 });
    const result = await poller.checkConfirmation('0xtimeout');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('TIMEOUT');
  });
});
