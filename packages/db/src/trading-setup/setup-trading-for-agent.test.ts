import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../index.js';
import type { TradingProfileReconciliationSaga } from '../trading-profiles/trading-profile-reconciliation-saga.js';

vi.mock('./trading-provider-link.js', () => ({
  createTradingProviderLink: vi.fn(),
}));
vi.mock('../agents/agent-config-service.js', () => ({
  grantConnectionToRunningAgent: vi.fn(),
}));

import { setupTradingForAgent, type SetupTradingDeps } from './setup-trading-for-agent.js';
import { createTradingProviderLink } from './trading-provider-link.js';
import { grantConnectionToRunningAgent } from '../agents/agent-config-service.js';

const defaults = {
  defaultTestCapital: '1000',
  defaultTestProvider: 'hyperliquid',
  generatedWalletTestSetupAllowed: true,
};

function fakeDb(activeRows: Array<{ id: string; venueAccountId: string | null }>): Database {
  return {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(activeRows),
        }),
      }),
    })),
  } as unknown as Database;
}

// A saga whose stored profile reports `storedCapital` for every venue account.
function sagaWithStoredCapital(storedCapital: string | null): TradingProfileReconciliationSaga {
  return {
    readCurrentProfiles: vi.fn(async (_owner: string, _actor: string, connections: Array<{ venueAccountId: string | null }>) => {
      const profiles = new Map<string, { capital: string | null }>();
      for (const connection of connections) {
        if (connection.venueAccountId) profiles.set(connection.venueAccountId, { capital: storedCapital });
      }
      return profiles;
    }),
  } as unknown as TradingProfileReconciliationSaga;
}

function makeDeps(overrides: Partial<SetupTradingDeps> = {}): SetupTradingDeps {
  return {
    db: fakeDb([]),
    saga: sagaWithStoredCapital('1000'),
    logger: { error: vi.fn() },
    defaults,
    ...overrides,
  };
}

const input = { userId: 'user-1', agentId: 'agent-1' };

describe('setupTradingForAgent', () => {
  beforeEach(() => {
    vi.mocked(createTradingProviderLink).mockReset();
    vi.mocked(grantConnectionToRunningAgent).mockReset();
    vi.mocked(grantConnectionToRunningAgent).mockResolvedValue({ ok: true, data: { granted: true } });
  });

  it('fails instead of reporting success when the stored capital does not match the request', async () => {
    const result = await setupTradingForAgent(
      makeDeps({
        db: fakeDb([{ id: 'conn-existing', venueAccountId: 'va-1' }]),
        saga: sagaWithStoredCapital('10000'),
      }),
      { ...input, capital: '500' },
    );

    expect(result).toMatchObject({ kind: 'fault', code: 'trading.capital_not_applied' });
  });

  it('refuses when test wallet setup is disabled by the operator', async () => {
    const result = await setupTradingForAgent(
      makeDeps({ defaults: { ...defaults, generatedWalletTestSetupAllowed: false } }),
      input,
    );

    expect(result).toMatchObject({ kind: 'error', code: 'wallet_generation.disabled' });
    expect(createTradingProviderLink).not.toHaveBeenCalled();
    expect(grantConnectionToRunningAgent).not.toHaveBeenCalled();
  });

  it('reuses an active connection on the default provider instead of creating one', async () => {
    const result = await setupTradingForAgent(
      makeDeps({ db: fakeDb([{ id: 'conn-existing', venueAccountId: 'va-1' }]) }),
      input,
    );

    expect(createTradingProviderLink).not.toHaveBeenCalled();
    expect(grantConnectionToRunningAgent).toHaveBeenCalledWith(
      expect.anything(),
      'agent-1',
      'conn-existing',
      'user-1',
      expect.anything(),
      { changes: { capital: '1000', executionDefaults: { mode: 'paper' } } },
    );
    expect(result).toMatchObject({ kind: 'ok', connectionId: 'conn-existing', reused: true, mode: 'paper', network: 'Hyperliquid' });
  });

  it('creates a generated test wallet on the provider network when none exists', async () => {
    vi.mocked(createTradingProviderLink).mockResolvedValue({
      kind: 'ok',
      credentialId: null,
      connectionId: 'conn-new',
      provider: 'hyperliquid',
      label: 'hyperliquid test wallet',
      venueAccountId: 'va-new',
      wallet: { address: '0xWallet', network: 'Hyperliquid' },
    });

    const result = await setupTradingForAgent(makeDeps(), input);

    expect(createTradingProviderLink).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
      expect.anything(),
      expect.objectContaining({ provider: 'hyperliquid', mode: { kind: 'generate', network: 'Hyperliquid' } }),
    );
    expect(result).toMatchObject({
      kind: 'ok',
      connectionId: 'conn-new',
      reused: false,
      wallet: { address: '0xWallet', network: 'Hyperliquid' },
    });
  });

  it('returns a plan limit from wallet creation without granting', async () => {
    vi.mocked(createTradingProviderLink).mockResolvedValue({
      kind: 'limit',
      error: { code: 'plan.connection_limit', message: 'Your plan allows 5 connections.' },
    });

    const result = await setupTradingForAgent(makeDeps(), input);

    expect(result).toEqual({
      kind: 'limit',
      error: { code: 'plan.connection_limit', message: 'Your plan allows 5 connections.' },
    });
    expect(grantConnectionToRunningAgent).not.toHaveBeenCalled();
  });

  it('uses the requested capital over the operator default', async () => {
    await setupTradingForAgent(
      makeDeps({ db: fakeDb([{ id: 'conn-existing', venueAccountId: 'va-1' }]) }),
      { ...input, capital: '250' },
    );

    expect(grantConnectionToRunningAgent).toHaveBeenCalledWith(
      expect.anything(),
      'agent-1',
      'conn-existing',
      'user-1',
      expect.anything(),
      { changes: { capital: '250', executionDefaults: { mode: 'paper' } } },
    );
  });

  it('maps a grant rejection to a plain error without creating the setup', async () => {
    vi.mocked(grantConnectionToRunningAgent).mockResolvedValue({
      ok: false,
      error: { code: 'agent.not_owned', message: 'You do not own this agent' },
    });

    const result = await setupTradingForAgent(
      makeDeps({ db: fakeDb([{ id: 'conn-existing', venueAccountId: 'va-1' }]) }),
      input,
    );

    expect(result).toEqual({ kind: 'error', code: 'agent.not_owned', message: 'You do not own this agent' });
  });
});
