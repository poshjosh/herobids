import { describe, it, expect, vi } from 'vitest';
import { ok, err } from '@herobids/domain';
import { JupiterConfirmationPoller } from './jupiter-confirmation.js';
import type { SolanaSignerPort } from './solana-signer.js';

function makeMockSigner(overrides?: Partial<SolanaSignerPort>): SolanaSignerPort {
  return {
    address: 'test-wallet-address',
    signAndSendTransaction: vi.fn().mockResolvedValue(ok({ signature: 'sig-1' })),
    getTransactionStatus: vi.fn().mockResolvedValue(ok({ confirmed: true, slot: 1234 })),
    ...overrides,
  };
}

describe('JupiterConfirmationPoller', () => {
  describe('with signer', () => {
    it('returns confirmed when signer reports confirmed', async () => {
      const signer = makeMockSigner({
        getTransactionStatus: vi.fn().mockResolvedValue(ok({ confirmed: true, slot: 5000 })),
      });
      const poller = new JupiterConfirmationPoller({ rpcUrl: 'http://localhost' }, signer);

      const result = await poller.checkConfirmation('tx-sig-123');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.confirmed).toBe(true);
      expect(result.data.blockNumber).toBe(5000);
    });

    it('returns not confirmed when signer reports pending', async () => {
      const signer = makeMockSigner({
        getTransactionStatus: vi.fn().mockResolvedValue(ok({ confirmed: false })),
      });
      const poller = new JupiterConfirmationPoller({ rpcUrl: 'http://localhost' }, signer);

      const result = await poller.checkConfirmation('tx-sig-456');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.confirmed).toBe(false);
    });

    it('propagates signer errors', async () => {
      const signer = makeMockSigner({
        getTransactionStatus: vi.fn().mockResolvedValue(err({ code: 'RPC_ERROR', message: 'timeout' })),
      });
      const poller = new JupiterConfirmationPoller({ rpcUrl: 'http://localhost' }, signer);

      const result = await poller.checkConfirmation('tx-sig-789');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('RPC_ERROR');
    });
  });

  describe('without signer (direct RPC)', () => {
    it('returns confirmed from RPC response', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          result: { value: [{ confirmationStatus: 'confirmed', slot: 999 }] },
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const poller = new JupiterConfirmationPoller({ rpcUrl: 'http://solana-rpc' });
      const result = await poller.checkConfirmation('tx-abc');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.confirmed).toBe(true);
      expect(result.data.blockNumber).toBe(999);

      vi.unstubAllGlobals();
    });

    it('returns not confirmed when status is null', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          result: { value: [null] },
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const poller = new JupiterConfirmationPoller({ rpcUrl: 'http://solana-rpc' });
      const result = await poller.checkConfirmation('tx-def');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.confirmed).toBe(false);

      vi.unstubAllGlobals();
    });

    it('returns error when transaction failed on-chain', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          result: { value: [{ confirmationStatus: 'confirmed', slot: 100, err: { InstructionError: [0, 'Custom'] } }] },
        }),
      });
      vi.stubGlobal('fetch', mockFetch);

      const poller = new JupiterConfirmationPoller({ rpcUrl: 'http://solana-rpc' });
      const result = await poller.checkConfirmation('tx-failed');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.confirmed).toBe(false);
      expect(result.data.failed).toBe(true);

      vi.unstubAllGlobals();
    });

    it('returns error when RPC fails', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
      });
      vi.stubGlobal('fetch', mockFetch);

      const poller = new JupiterConfirmationPoller({ rpcUrl: 'http://solana-rpc' });
      const result = await poller.checkConfirmation('tx-rpc-fail');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('RPC_ERROR');

      vi.unstubAllGlobals();
    });
  });
});
