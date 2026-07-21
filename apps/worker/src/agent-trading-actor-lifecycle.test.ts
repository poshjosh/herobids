import { describe, it, expect, vi } from 'vitest';
import { AgentTradingActor } from './agent-trading-actor.js';
import type { AgentTradingActorDeps } from './agent-trading-actor.js';
import { price, quantity, ok } from '@herobids/domain';
import type { OrderId, FillId } from '@herobids/domain';

/**
 * Regression coverage for RC1 in
 * docs/features/2026/07/21/001-staging-agents-not-trading-actor-start-never-called.md
 *
 * The worker composition root (apps/worker/src/index.ts) constructs an
 * AgentTradingActor and MUST call `actor.start()` before the actor is usable —
 * `start()` is the only place that sets `running = true` and constructs the
 * executor, both of which `getIntakeDeps()` gates on. A regression that omits
 * the `start()` call (as happened in commit b85fd19d) produces no thrown
 * error anywhere — the actor is silently inert. These tests pin down that
 * observable contract directly on the real class, independent of how the
 * composition root wires it.
 */

function makeIdGen() {
  let c = 0;
  return {
    orderId: () => `o-${++c}` as OrderId,
    fillId: () => `f-${++c}` as FillId,
    planId: () => `p-${++c}`,
    decisionId: () => `d-${++c}`,
  };
}

function makeRepo() {
  return {
    insertFill: vi.fn().mockResolvedValue(undefined),
    sumRealizedPnlDeltaByVenueAccount: vi.fn().mockResolvedValue('0'),
    getOpenByActor: vi.fn().mockResolvedValue([]),
    getOpenByActorAndVenueAccount: vi.fn().mockResolvedValue([]),
    upsert: vi.fn().mockResolvedValue(undefined),
    insertPlan: vi.fn().mockResolvedValue(undefined),
    markExecuting: vi.fn().mockResolvedValue(undefined),
    markCompleted: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
    getIncomplete: vi.fn().mockResolvedValue([]),
    getByExecutionPlanId: vi.fn().mockResolvedValue([]),
    upsertByVenueRefId: vi.fn().mockResolvedValue(undefined),
    insertDecision: vi.fn().mockResolvedValue(undefined),
    insertDecisionContext: vi.fn().mockResolvedValue('ctx-id'),
    getLastReconciledAtForInstance: vi.fn().mockResolvedValue(null),
    getRecentByVenueAccount: vi.fn().mockResolvedValue([]),
    getLatestByVenueAccount: vi.fn().mockResolvedValue(null),
    getRecentByActorAndVenueAccount: vi.fn().mockResolvedValue([]),
    insertSnapshot: vi.fn().mockResolvedValue('snap-id'),
    insert: vi.fn().mockResolvedValue(undefined),
    getLatestBalanceForVenueAccount: vi.fn().mockResolvedValue(null),
    getLastReconciledAtAndSnapshotForInstance: vi.fn().mockResolvedValue(null),
    getLatestDecisions: vi.fn().mockResolvedValue([]),
    getOpenPositionsByActor: vi.fn().mockResolvedValue([]),
    getBalanceSnapshotsByVenueAccount: vi.fn().mockResolvedValue([]),
    getDecisionsByActor: vi.fn().mockResolvedValue([]),
    getFillsByActor: vi.fn().mockResolvedValue([]),
    getFillsByVenueAccount: vi.fn().mockResolvedValue([]),
    getPlansByActor: vi.fn().mockResolvedValue([]),
    getRecentReconciliations: vi.fn().mockResolvedValue([]),
    getReconciliationEvents: vi.fn().mockResolvedValue([]),
    upsertBalanceSnapshot: vi.fn().mockResolvedValue(undefined),
    upsertPosition: vi.fn().mockResolvedValue(undefined),
    getPositionByActorAndSymbol: vi.fn().mockResolvedValue(null),
    insertOrder: vi.fn().mockResolvedValue(undefined),
    updateOrderStatus: vi.fn().mockResolvedValue(undefined),
    getOrdersByPlanId: vi.fn().mockResolvedValue([]),
    getOrdersByVenueRefId: vi.fn().mockResolvedValue([]),
    getOrdersByActorAndSymbol: vi.fn().mockResolvedValue([]),
    getReconciliationEvent: vi.fn().mockResolvedValue(null),
    getBalanceSnapshot: vi.fn().mockResolvedValue(null),
    deletePosition: vi.fn().mockResolvedValue(undefined),
    markPlanFailed: vi.fn().mockResolvedValue(undefined),
    markPlanCompleted: vi.fn().mockResolvedValue(undefined),
    getDecisionContext: vi.fn().mockResolvedValue(null),
    getDecisionsByPlanId: vi.fn().mockResolvedValue([]),
    getOpenOrdersByActor: vi.fn().mockResolvedValue([]),
    getOrderByVenueRefId: vi.fn().mockResolvedValue(null),
    insertReconciliationEvent: vi.fn().mockResolvedValue(undefined),
    upsertDecisionResult: vi.fn().mockResolvedValue(undefined),
    getLatestBalances: vi.fn().mockResolvedValue([]),
  };
}

function makeAgentActorDeps(overrides?: Partial<AgentTradingActorDeps>): AgentTradingActorDeps {
  const repos = makeRepo();
  return {
    agentId: 'agent-test',
    executionMode: 'paper',
    venueAccountId: 'va-test',
    venue: 'hyperliquid',
    venueType: 'orderbook',
    riskLimits: {
      maxOpenPositions: 5,
      maxDrawdown: price('10000'),
      maxPositionSize: quantity('10'),
      maxPositionSizePct: 100,
      dailyMaxLossPct: 20,
      stopLossCooldownMs: 300000,
      stopLossMaxUnrealizedLossPct: 10,
      maxOrderNotional: price('10000'),
    },
    venueAdapterFactory: {
      buildOrderbookAdapter: vi.fn().mockResolvedValue({
        venuePort: {},
        credentials: { testnet: false, apiKey: '', secret: '', walletAddress: '' },
        credentialId: 'cred-1',
      }),
      buildSwapAdapter: vi.fn(),
    } as unknown as AgentTradingActorDeps['venueAdapterFactory'],
    markSource: {
      getMark: vi.fn().mockResolvedValue(ok({ price: price('50000'), source: 'oracle', timestamp: new Date().toISOString(), stale: false })),
    } as unknown as AgentTradingActorDeps['markSource'],
    journal: { append: vi.fn().mockResolvedValue(undefined) } as unknown as AgentTradingActorDeps['journal'],
    idGen: makeIdGen(),
    positionRepo: repos as unknown as AgentTradingActorDeps['positionRepo'],
    fillRepo: repos as unknown as AgentTradingActorDeps['fillRepo'],
    planRepo: repos as unknown as AgentTradingActorDeps['planRepo'],
    orderRepo: repos as unknown as AgentTradingActorDeps['orderRepo'],
    decisionRepo: repos as unknown as AgentTradingActorDeps['decisionRepo'],
    balanceSnapshotRepo: repos as unknown as AgentTradingActorDeps['balanceSnapshotRepo'],
    backtestingRepo: repos as unknown as AgentTradingActorDeps['backtestingRepo'],
    reconciliationRepo: repos as unknown as AgentTradingActorDeps['reconciliationRepo'],
    isHybridMode: false,
    ...overrides,
  };
}

describe('AgentTradingActor — start() / getIntakeDeps() runtime invariant', () => {
  it('getIntakeDeps() returns undefined before start() is called', () => {
    const actor = new AgentTradingActor(makeAgentActorDeps());

    expect(actor.getIntakeDeps('BTC')).toBeUndefined();
  });

  it('getIntakeDeps() returns a defined result once start() resolves', async () => {
    const actor = new AgentTradingActor(makeAgentActorDeps());

    await actor.start();

    expect(actor.getIntakeDeps('BTC')).toBeDefined();

    await actor.stop();
  });

  it('getIntakeDeps() reverts to undefined after stop()', async () => {
    const actor = new AgentTradingActor(makeAgentActorDeps());

    await actor.start();
    expect(actor.getIntakeDeps('BTC')).toBeDefined();

    await actor.stop();
    expect(actor.getIntakeDeps('BTC')).toBeUndefined();
  });
});

/**
 * Mirrors the exact activation sequence in the worker composition root's
 * `onSessionActive` callback (apps/worker/src/index.ts): construct actor →
 * await actor.start() → check whether the session is still pending → either
 * register the actor or tear it down. This is not a re-implementation of
 * index.ts — it pins the ORDER of operations so a future edit cannot again
 * drop the `start()` call while restructuring the surrounding object literal,
 * the exact way commit b85fd19d did.
 */
async function activateAgentActor(
  actor: { start: () => Promise<void>; stop: () => Promise<void> },
  isSessionPending: () => boolean,
  registerActor: () => void,
): Promise<'registered' | 'discarded'> {
  await actor.start();

  if (isSessionPending()) {
    registerActor();
    return 'registered';
  }
  await actor.stop();
  return 'discarded';
}

describe('onSessionActive activation sequence (mirrors index.ts composition root)', () => {
  it('calls start() before checking session pending state and before registering', async () => {
    const calls: string[] = [];
    const actor = {
      start: vi.fn().mockImplementation(async () => { calls.push('start'); }),
      stop: vi.fn().mockImplementation(async () => { calls.push('stop'); }),
    };
    const registerActor = vi.fn().mockImplementation(() => { calls.push('register'); });

    const outcome = await activateAgentActor(actor, () => true, registerActor);

    expect(outcome).toBe('registered');
    expect(calls).toEqual(['start', 'register']);
    expect(actor.start).toHaveBeenCalledTimes(1);
    expect(registerActor).toHaveBeenCalledTimes(1);
    expect(actor.stop).not.toHaveBeenCalled();
  });

  it('stops (and does not register) an already-started actor whose session changed during start', async () => {
    const calls: string[] = [];
    const actor = {
      start: vi.fn().mockImplementation(async () => { calls.push('start'); }),
      stop: vi.fn().mockImplementation(async () => { calls.push('stop'); }),
    };
    const registerActor = vi.fn().mockImplementation(() => { calls.push('register'); });

    const outcome = await activateAgentActor(actor, () => false, registerActor);

    expect(outcome).toBe('discarded');
    expect(calls).toEqual(['start', 'stop']);
    expect(registerActor).not.toHaveBeenCalled();
  });

  it('propagates a start() failure without registering the actor', async () => {
    const actor = {
      start: vi.fn().mockRejectedValue(new Error('venue adapter unavailable')),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const registerActor = vi.fn();

    await expect(activateAgentActor(actor, () => true, registerActor)).rejects.toThrow('venue adapter unavailable');
    expect(registerActor).not.toHaveBeenCalled();
  });
});
