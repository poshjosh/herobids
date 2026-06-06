import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Reconciler } from './reconciler.js';
import type { ReconcilerConfig, ReconcilerDeps, VenueStateLoader } from './reconciler.js';
import type { VenueState, LocalState } from './reconcile.js';
import { Decimal } from '@herobids/domain';

function makeConfig(overrides?: Partial<ReconcilerConfig>): ReconcilerConfig {
  return {
    intervalMs: 60000,
    driftAlertOnly: true,
    positionDriftThreshold: '0',
    balanceDriftThreshold: '0',
    ...overrides,
  };
}

function emptyLocalState(): LocalState {
  return { positions: [], balances: [], recentFills: [], openOrders: [] };
}

function emptyVenueState(): VenueState {
  return {
    positions: [],
    balances: { balances: [], timestamp: new Date().toISOString() },
    recentFills: [],
    openOrders: [],
  };
}

function makeDeps(overrides?: Partial<ReconcilerDeps>): ReconcilerDeps {
  return {
    fetchVenueState: vi.fn().mockResolvedValue(emptyVenueState()),
    loadLocalState: vi.fn().mockResolvedValue(emptyLocalState()),
    persistResult: vi.fn().mockResolvedValue(undefined),
    journal: { append: vi.fn().mockResolvedValue(undefined) } as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
    actorId: 'inst-1',
    venueAccountId: 'va-1',
    ...overrides,
  };
}

describe('Reconciler with VenueStateLoader', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('calls fetchVenueState with null since when no getLastReconciledAt provided', async () => {
    const fetchVenueState = vi.fn().mockResolvedValue(emptyVenueState());
    const deps = makeDeps({ fetchVenueState });
    const reconciler = new Reconciler(makeConfig(), deps);

    reconciler.start();
    const result = await reconciler.runPass();

    expect(fetchVenueState).toHaveBeenCalledWith(null);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('match');

    reconciler.stop();
  });

  it('calls fetchVenueState with since Date from getLastReconciledAt', async () => {
    const lastReconciled = new Date('2026-05-24T10:00:00Z');
    const fetchVenueState = vi.fn().mockResolvedValue(emptyVenueState());
    const deps = makeDeps({
      fetchVenueState,
      getLastReconciledAt: vi.fn().mockResolvedValue(lastReconciled),
    });
    const reconciler = new Reconciler(makeConfig(), deps);

    reconciler.start();
    await reconciler.runPass();

    expect(fetchVenueState).toHaveBeenCalledWith(lastReconciled);
    reconciler.stop();
  });

  it('returns null when fetchVenueState returns null', async () => {
    const fetchVenueState = vi.fn().mockResolvedValue(null);
    const deps = makeDeps({ fetchVenueState });
    const reconciler = new Reconciler(makeConfig(), deps);

    reconciler.start();
    const result = await reconciler.runPass();

    expect(result).toBeNull();
    // Should not persist or journal anything
    expect(deps.persistResult).not.toHaveBeenCalled();
    expect(deps.journal.append).not.toHaveBeenCalled();

    reconciler.stop();
  });

  it('detects drift and journals it', async () => {
    const venueState: VenueState = {
      positions: [{ symbol: 'BTC/USD', side: 'long', size: new Decimal('2'), entryPrice: new Decimal('50000') }],
      balances: { balances: [], timestamp: new Date().toISOString() },
      recentFills: [],
      openOrders: [],
    };
    const deps = makeDeps({
      fetchVenueState: vi.fn().mockResolvedValue(venueState),
      loadLocalState: vi.fn().mockResolvedValue(emptyLocalState()),
    });
    const reconciler = new Reconciler(makeConfig(), deps);

    reconciler.start();
    const result = await reconciler.runPass();

    expect(result!.status).toBe('drift_detected');
    expect(result!.diffs.length).toBeGreaterThan(0);
    expect(deps.persistResult).toHaveBeenCalled();
    expect(deps.journal.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'reconciliation.drift_detected',
      }),
    );

    reconciler.stop();
  });

  it('does not run pass when stopped', async () => {
    const fetchVenueState = vi.fn().mockResolvedValue(emptyVenueState());
    const deps = makeDeps({ fetchVenueState });
    const reconciler = new Reconciler(makeConfig(), deps);

    // Don't start — should return null
    const result = await reconciler.runPass();

    expect(result).toBeNull();
    expect(fetchVenueState).not.toHaveBeenCalled();
  });

  it('prevents concurrent passes', async () => {
    let resolveVenueState!: (v: VenueState) => void;
    const fetchVenueState = vi.fn().mockImplementation(() =>
      new Promise<VenueState>((resolve) => { resolveVenueState = resolve; })
    );
    const deps = makeDeps({ fetchVenueState });
    const reconciler = new Reconciler(makeConfig(), deps);

    reconciler.start();
    const pass1 = reconciler.runPass();
    const pass2 = reconciler.runPass(); // should be skipped (concurrent)

    // Resolve the first pass
    resolveVenueState(emptyVenueState());
    const [result1, result2] = await Promise.all([pass1, pass2]);

    expect(result1).not.toBeNull();
    expect(result2).toBeNull(); // concurrent pass was skipped
    expect(fetchVenueState).toHaveBeenCalledTimes(1);

    reconciler.stop();
  });

  it('invokes onReconciled callback after successful pass', async () => {
    const onReconciled = vi.fn();
    const deps = makeDeps({ onReconciled });
    const reconciler = new Reconciler(makeConfig(), deps);

    reconciler.start();
    await reconciler.runPass();

    expect(onReconciled).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'match' }),
    );

    reconciler.stop();
  });

  it('handles fetchVenueState rejection gracefully', async () => {
    const fetchVenueState = vi.fn().mockRejectedValue(new Error('network timeout'));
    const deps = makeDeps({ fetchVenueState });
    const reconciler = new Reconciler(makeConfig(), deps);

    reconciler.start();
    const result = await reconciler.runPass();

    expect(result).toBeNull();
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Reconciliation pass failed',
    );

    reconciler.stop();
  });
});
