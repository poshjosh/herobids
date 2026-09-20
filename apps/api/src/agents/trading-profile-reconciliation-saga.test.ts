import { describe, expect, it, vi } from 'vitest';
import type {
  TradingProfileOutboxAction,
  TradingProfileOutboxState,
} from '@herobids/db';
import type { TradertonClientResult } from '@herobids/domain/traderton';
import {
  TradingProfileReconciliationSaga,
  TradingProfileResponseValidationError,
  TradingProfileCeilingViolationError,
  type TradingProfileSagaBoundary,
} from './trading-profile-reconciliation-saga.js';
import type { TradingProfileReconciliationPlan } from './trading-profile-reconciliation.js';

const plan: TradingProfileReconciliationPlan = {
  upserts: [{
    actorId: 'agent-1',
    venueAccountId: 'venue-a',
    capital: '100',
    riskPosture: null,
    executionDefaults: null,
  }],
  clears: ['venue-b'],
  selectedBinding: { previous: null, next: { connectionId: 'connection-a', venueAccountId: 'venue-a' } },
  inverseActions: [],
};

function action(actionId: string, kind: 'set' | 'clear', venueAccountId: string): TradingProfileOutboxAction {
  return { actionId, kind, venueAccountId, state: 'pending', attempts: 0, error: null };
}

function row(state: TradingProfileOutboxState, actions: TradingProfileOutboxAction[]) {
  return {
    id: 'outbox-1',
    operationId: 'operation-1',
    localMutationId: 'mutation-1',
    ownerId: 'owner-1',
    actorId: 'agent-1',
    state,
    actions,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function success(operationId = 'operation-1', revision = '1'): TradertonClientResult {
  return { kind: 'success', requestId: 'request-1', correlationId: 'correlation-1', payload: { operationId, revision } };
}

function clearSuccess(operationId = 'operation-1'): TradertonClientResult {
  return { kind: 'success', requestId: 'request-1', correlationId: 'correlation-1', payload: { operationId, revision: null } };
}

function successForTool(toolName: string): TradertonClientResult {
  if (toolName === 'clear_agent_trading_profile') return clearSuccess();
  return success();
}

function profilePayload(overrides: Record<string, unknown> = {}) {
  return {
    actorId: 'agent-1',
    venueAccountId: 'venue-a',
    capital: '100',
    riskPosture: { maxOpenPositions: 2 },
    riskOverrides: overrides,
    executionDefaults: { mode: 'paper' },
  };
}

describe('TradingProfileReconciliationSaga', () => {
  it('reads a typed remote profile for every distinct locally bound account', async () => {
    const boundary: TradingProfileSagaBoundary = {
      invoke: vi.fn(async ({ payload }) => ({
        kind: 'success',
        payload: {
          actorId: 'agent-1',
          venueAccountId: (payload as { venueAccountId: string }).venueAccountId,
          capital: (payload as { venueAccountId: string }).venueAccountId === 'venue-a' ? '100' : '200',
          riskPosture: null,
          riskOverrides: {},
          executionDefaults: { mode: 'paper' },
        },
      }) as TradertonClientResult),
    };
    const saga = new TradingProfileReconciliationSaga({} as never, boundary);

    const profiles = await saga.readCurrentProfiles('owner-1', 'agent-1', [
      { connectionId: 'connection-a', venueAccountId: 'venue-a', active: true, ready: true, isDefault: true },
      { connectionId: 'connection-a-duplicate', venueAccountId: 'venue-a', active: true, ready: true, isDefault: false },
      { connectionId: 'connection-b', venueAccountId: 'venue-b', active: true, ready: true, isDefault: false },
    ]);

    expect(profiles).toEqual(new Map([
      ['venue-a', { actorId: 'agent-1', venueAccountId: 'venue-a', capital: '100', riskPosture: null, executionDefaults: { mode: 'paper' } }],
      ['venue-b', { actorId: 'agent-1', venueAccountId: 'venue-b', capital: '200', riskPosture: null, executionDefaults: { mode: 'paper' } }],
    ]));
    expect(vi.mocked(boundary.invoke).mock.calls).toHaveLength(2);
    expect(vi.mocked(boundary.invoke).mock.calls.every(([call]) => call.subject.actor.type === 'agent')).toBe(true);
  });

  it.each([
    ['missing profile fields', {}],
    ['capital', { ...profilePayload(), capital: 100 }],
    ['risk posture', { ...profilePayload(), riskPosture: { maxOpenPositions: 0 } }],
    ['execution defaults', { ...profilePayload(), executionDefaults: { mode: 'invalid' } }],
    ['risk overrides', { ...profilePayload({ unexpected: true }) }],
    ['actor identity', { ...profilePayload(), actorId: 'agent-2' }],
    ['venue account identity', { ...profilePayload(), venueAccountId: 'venue-b' }],
  ])('rejects malformed or mismatched %s responses before local staging', async (_case, payload) => {
    const outbox = {
      createOrLoad: vi.fn(),
      inTransaction: vi.fn(),
    };
    const boundary: TradingProfileSagaBoundary = {
      invoke: vi.fn(async () => ({ kind: 'success', data: {}, payload }) as TradertonClientResult),
    };
    const saga = new TradingProfileReconciliationSaga(outbox as never, boundary);
    const commitLocal = vi.fn();

    await expect(saga.executeStaged({
      ownerId: 'owner-1',
      actorId: 'agent-1',
      localMutationId: 'mutation-1',
      preparePlannerInput: async () => ({
        prior: {
          profiles: await saga.readCurrentProfiles('owner-1', 'agent-1', [{ connectionId: 'connection-a', venueAccountId: 'venue-a', active: true, ready: true, isDefault: true }]),
          connections: [],
        },
        proposed: { profiles: new Map(), connections: [] },
      }),
      commitLocal,
    })).rejects.toBeInstanceOf(TradingProfileResponseValidationError);

    expect(outbox.createOrLoad).not.toHaveBeenCalled();
    expect(outbox.inTransaction).not.toHaveBeenCalled();
    expect(commitLocal).not.toHaveBeenCalled();
  });

  it('sends a complete forward manifest transiently before atomically marking the local mutation committed', async () => {
    const actions = [action('set-a', 'set', 'venue-a'), action('clear-b', 'clear', 'venue-b')];
    const outbox = {
      createOrLoad: vi.fn().mockResolvedValue(row('pending_remote', actions)),
      update: vi.fn().mockResolvedValue(undefined),
      markLocalCommitted: vi.fn().mockResolvedValue(undefined),
      claimLive: vi.fn().mockResolvedValue('live-claim'),
      releaseClaim: vi.fn().mockResolvedValue(undefined),
      claimRecoverable: vi.fn(),
      inTransaction: vi.fn(async (callback) => callback('transaction-handle')),
    };
    const boundary: TradingProfileSagaBoundary = { invoke: vi.fn(async ({ toolName }) => successForTool(toolName)) };
    const saga = new TradingProfileReconciliationSaga(outbox as never, boundary);
    const commitLocal = vi.fn(async (_tx, markLocalCommitted: () => Promise<void>) => markLocalCommitted());

    await saga.execute({ ownerId: 'owner-1', actorId: 'agent-1', localMutationId: 'mutation-1', plan, commitLocal });

    const firstPayload = vi.mocked(boundary.invoke).mock.calls[0]![0].payload as { actions: unknown[] };
    expect(firstPayload.actions).toEqual([
      expect.objectContaining({ actionId: 'set-a', kind: 'set', venueAccountId: 'venue-a', capital: '100' }),
      expect.objectContaining({ actionId: 'clear-b', kind: 'clear', venueAccountId: 'venue-b', capital: null }),
    ]);
    expect(commitLocal).toHaveBeenCalledOnce();
    expect(commitLocal).toHaveBeenCalledWith('transaction-handle', expect.any(Function));
    expect(outbox.markLocalCommitted).toHaveBeenCalledWith('transaction-handle', 'operation-1');
    expect(vi.mocked(boundary.invoke).mock.calls.map(([call]) => call.toolName)).toEqual([
      'set_agent_trading_profile',
      'clear_agent_trading_profile',
      'finalize_agent_trading_profile_change',
    ]);
  });

  it.each([
    ['set', {}, 'set_agent_trading_profile'],
    ['set', { operationId: 'operation-1', revision: null }, 'set_agent_trading_profile'],
    ['set', { operationId: 'different-operation', revision: '1' }, 'set_agent_trading_profile'],
    ['clear', {}, 'clear_agent_trading_profile'],
    ['clear', { operationId: 'operation-1', revision: '1' }, 'clear_agent_trading_profile'],
    ['clear', { operationId: 'different-operation', revision: '1' }, 'clear_agent_trading_profile'],
  ] as const)('does not commit locally when a %s response is malformed or mismatched', async (_operation, payload, toolName) => {
    const actions = toolName === 'set_agent_trading_profile'
      ? [action('set-a', 'set', 'venue-a')]
      : [action('clear-a', 'clear', 'venue-a')];
    const outbox = {
      createOrLoad: vi.fn().mockResolvedValue(row('pending_remote', actions)),
      update: vi.fn().mockResolvedValue(undefined),
      markLocalCommitted: vi.fn(),
      claimLive: vi.fn().mockResolvedValue('live-claim'),
      releaseClaim: vi.fn().mockResolvedValue(undefined),
      claimRecoverable: vi.fn(),
      inTransaction: vi.fn(async (callback) => callback('transaction-handle')),
    };
    const boundary: TradingProfileSagaBoundary = {
      invoke: vi.fn(async ({ toolName: invokedToolName }) => invokedToolName === toolName
        ? { kind: 'success', requestId: 'request-1', correlationId: 'correlation-1', payload }
        : success()),
    };
    const saga = new TradingProfileReconciliationSaga(outbox as never, boundary);
    const commitLocal = vi.fn(async (_tx, markLocalCommitted: () => Promise<void>) => markLocalCommitted());
    const mutationPlan = toolName === 'set_agent_trading_profile'
      ? { ...plan, clears: [] }
      : { ...plan, upserts: [] };

    await expect(saga.execute({
      ownerId: 'owner-1', actorId: 'agent-1', localMutationId: 'mutation-1', plan: mutationPlan, commitLocal,
    })).rejects.toBeInstanceOf(TradingProfileResponseValidationError);

    expect(commitLocal).not.toHaveBeenCalled();
    expect(outbox.markLocalCommitted).not.toHaveBeenCalled();
    expect(outbox.update).toHaveBeenCalledWith('outbox-1', 'pending_remote', expect.arrayContaining([
      expect.objectContaining({ kind: _operation, state: 'failed' }),
    ]), expect.stringContaining('response'));
    expect(vi.mocked(boundary.invoke).mock.calls.map(([call]) => call.toolName)).toEqual([
      toolName,
      'rollback_agent_trading_profile_change',
    ]);
  });

  it('commits and finalizes when clear returns the producer acknowledgement with a null revision', async () => {
    const actions = [action('clear-a', 'clear', 'venue-a')];
    const outbox = {
      createOrLoad: vi.fn().mockResolvedValue(row('pending_remote', actions)),
      update: vi.fn().mockResolvedValue(undefined),
      markLocalCommitted: vi.fn().mockResolvedValue(undefined),
      claimLive: vi.fn().mockResolvedValue('live-claim'),
      releaseClaim: vi.fn().mockResolvedValue(undefined),
      claimRecoverable: vi.fn(),
      inTransaction: vi.fn(async (callback) => callback('transaction-handle')),
    };
    const boundary: TradingProfileSagaBoundary = {
      invoke: vi.fn(async ({ toolName }) => toolName === 'clear_agent_trading_profile'
        ? clearSuccess()
        : success()),
    };
    const saga = new TradingProfileReconciliationSaga(outbox as never, boundary);
    const commitLocal = vi.fn(async (_tx, markLocalCommitted: () => Promise<void>) => markLocalCommitted());

    await saga.execute({
      ownerId: 'owner-1', actorId: 'agent-1', localMutationId: 'mutation-1',
      plan: { ...plan, upserts: [] }, commitLocal,
    });

    expect(commitLocal).toHaveBeenCalledOnce();
    expect(outbox.markLocalCommitted).toHaveBeenCalledWith('transaction-handle', 'operation-1');
    expect(vi.mocked(boundary.invoke).mock.calls.map(([call]) => call.toolName)).toEqual([
      'clear_agent_trading_profile',
      'finalize_agent_trading_profile_change',
    ]);
  });

  it('commits a no-op plan locally without creating an operation or invoking the boundary', async () => {
    const outbox = {
      createOrLoad: vi.fn(),
      update: vi.fn(),
      markLocalCommitted: vi.fn(),
      claimLive: vi.fn(),
      releaseClaim: vi.fn(),
      claimRecoverable: vi.fn(),
      inTransaction: vi.fn(async (callback) => callback('transaction-handle')),
    };
    const boundary: TradingProfileSagaBoundary = { invoke: vi.fn() };
    const saga = new TradingProfileReconciliationSaga(outbox as never, boundary);
    const commitLocal = vi.fn().mockResolvedValue(undefined);

    await saga.execute({
      ownerId: 'owner-1',
      actorId: 'agent-1',
      localMutationId: 'mutation-1',
      plan: { ...plan, upserts: [], clears: [] },
      commitLocal,
    });

    expect(commitLocal).toHaveBeenCalledWith('transaction-handle', expect.any(Function));
    expect(outbox.createOrLoad).not.toHaveBeenCalled();
    expect(vi.mocked(boundary.invoke)).not.toHaveBeenCalled();
  });

  it('resumes and compensates a pre-commit operation using only durable operation metadata', async () => {
    const actions = [action('set-a', 'set', 'venue-a')];
    const outbox = {
      createOrLoad: vi.fn(),
      update: vi.fn().mockResolvedValue(undefined),
      markLocalCommitted: vi.fn(),
      claimLive: vi.fn(),
      releaseClaim: vi.fn().mockResolvedValue(undefined),
      claimRecoverable: vi.fn().mockResolvedValue([{ ...row('pending_remote', actions), claimToken: 'recovery-claim' }]),
      inTransaction: vi.fn(),
    };
    const boundary: TradingProfileSagaBoundary = { invoke: vi.fn(async ({ toolName }) => successForTool(toolName)) };
    const saga = new TradingProfileReconciliationSaga(outbox as never, boundary);

    await expect(saga.recover(10)).resolves.toEqual({ recovered: 1, failed: 0 });

    expect(vi.mocked(boundary.invoke).mock.calls.map(([call]) => ({ toolName: call.toolName, payload: call.payload }))).toEqual([
      { toolName: 'resume_agent_trading_profile_change', payload: { actorId: 'agent-1', operationId: 'operation-1' } },
      { toolName: 'rollback_agent_trading_profile_change', payload: { actorId: 'agent-1', operationId: 'operation-1' } },
    ]);
  });

  it('retries finalization after a crash following local commit', async () => {
    const actions = [action('set-a', 'set', 'venue-a')];
    const outbox = {
      createOrLoad: vi.fn(),
      update: vi.fn().mockResolvedValue(undefined),
      markLocalCommitted: vi.fn(),
      claimLive: vi.fn(),
      releaseClaim: vi.fn().mockResolvedValue(undefined),
      claimRecoverable: vi.fn().mockResolvedValue([{ ...row('local_committed', actions), claimToken: 'recovery-claim' }]),
      inTransaction: vi.fn(),
    };
    const boundary: TradingProfileSagaBoundary = { invoke: vi.fn().mockResolvedValue(success()) };
    const saga = new TradingProfileReconciliationSaga(outbox as never, boundary);

    await expect(saga.recover(10)).resolves.toEqual({ recovered: 1, failed: 0 });

    expect(vi.mocked(boundary.invoke)).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'finalize_agent_trading_profile_change',
      payload: { actorId: 'agent-1', operationId: 'operation-1' },
    }));
  });

  it('releases the live claim after compensating a local transaction failure', async () => {
    const actions = [action('set-a', 'set', 'venue-a')];
    const outbox = {
      createOrLoad: vi.fn().mockResolvedValue(row('pending_remote', actions)),
      update: vi.fn().mockResolvedValue(undefined),
      markLocalCommitted: vi.fn(),
      claimLive: vi.fn().mockResolvedValue('live-claim'),
      releaseClaim: vi.fn().mockResolvedValue(undefined),
      claimRecoverable: vi.fn(),
      inTransaction: vi.fn(async (callback) => callback('transaction-handle')),
    };
    const boundary: TradingProfileSagaBoundary = { invoke: vi.fn().mockResolvedValue(success()) };
    const saga = new TradingProfileReconciliationSaga(outbox as never, boundary);

    await expect(saga.execute({
      ownerId: 'owner-1',
      actorId: 'agent-1',
      localMutationId: 'mutation-1',
      plan,
      commitLocal: async () => { throw new Error('local write failed'); },
    })).rejects.toThrow('local write failed');

    expect(outbox.releaseClaim).toHaveBeenCalledWith('operation-1', 'live-claim');
    expect(vi.mocked(boundary.invoke).mock.calls.map(([call]) => call.toolName)).toContain('rollback_agent_trading_profile_change');
  });

  it('stages remote reconciliation before entering the local transaction and returns the local result', async () => {
    const actions = [action('set-a', 'set', 'venue-a')];
    const calls: string[] = [];
    const outbox = {
      createOrLoad: vi.fn().mockResolvedValue(row('pending_remote', actions)),
      update: vi.fn().mockResolvedValue(undefined),
      markLocalCommitted: vi.fn().mockResolvedValue(undefined),
      claimLive: vi.fn().mockResolvedValue('live-claim'),
      releaseClaim: vi.fn().mockResolvedValue(undefined),
      claimRecoverable: vi.fn(),
      inTransaction: vi.fn(async (callback) => {
        calls.push('transaction');
        return callback('transaction-handle');
      }),
    };
    const boundary: TradingProfileSagaBoundary = {
      invoke: vi.fn(async (input) => {
        calls.push(input.toolName);
        return success();
      }),
    };
    const saga = new TradingProfileReconciliationSaga(outbox as never, boundary);

    await expect(saga.executeStaged({
      ownerId: 'owner-1',
      actorId: 'agent-1',
      localMutationId: 'mutation-1',
      preparePlannerInput: () => ({
        prior: { profiles: new Map(), connections: [] },
        proposed: { profiles: new Map([['venue-a', plan.upserts[0]!]]), connections: [{ connectionId: 'connection-a', venueAccountId: 'venue-a', active: true, ready: true, isDefault: true }] },
      }),
      commitLocal: async (_tx, markLocalCommitted) => {
        calls.push('local-write');
        await markLocalCommitted();
        return { response: 'unchanged' };
      },
    })).resolves.toEqual({ response: 'unchanged' });

    expect(calls).toEqual([
      'set_agent_trading_profile',
      'transaction',
      'local-write',
      'finalize_agent_trading_profile_change',
    ]);
  });

  it('leaves a successful child operation unfinalized when a fanout defers finalization', async () => {
    const actions = [action('set-a', 'set', 'venue-a')];
    const outbox = {
      createOrLoad: vi.fn().mockResolvedValue(row('pending_remote', actions)),
      update: vi.fn().mockResolvedValue(undefined),
      markLocalCommitted: vi.fn().mockResolvedValue(undefined),
      claimLive: vi.fn().mockResolvedValue('live-claim'),
      releaseClaim: vi.fn().mockResolvedValue(undefined),
      claimRecoverable: vi.fn(),
      inTransaction: vi.fn(async (callback) => callback('transaction-handle')),
    };
    const boundary: TradingProfileSagaBoundary = { invoke: vi.fn().mockResolvedValue(success()) };
    const saga = new TradingProfileReconciliationSaga(outbox as never, boundary);
    const staged = vi.fn();

    await saga.execute({
      ownerId: 'owner-1', actorId: 'agent-1', localMutationId: 'mutation-1', plan,
      commitLocal: async (_tx, markLocalCommitted) => markLocalCommitted(),
      onOperationStaged: staged,
      deferFinalization: true,
    });

    expect(staged).toHaveBeenCalledWith({ operationId: 'operation-1', ownerId: 'owner-1', actorId: 'agent-1' });
    expect(vi.mocked(boundary.invoke).mock.calls.map(([call]) => call.toolName)).toEqual([
      'set_agent_trading_profile',
    ]);
  });

  it('durably completes a successfully finalized fanout operation', async () => {
    const outbox = {
      updateByOperationId: vi.fn().mockResolvedValue(undefined),
    };
    const boundary: TradingProfileSagaBoundary = { invoke: vi.fn().mockResolvedValue(success()) };
    const saga = new TradingProfileReconciliationSaga(outbox as never, boundary);

    await saga.finalize({ operationId: 'operation-1', ownerId: 'owner-1', actorId: 'agent-1' });

    expect(outbox.updateByOperationId).toHaveBeenCalledWith('operation-1', 'completed');
  });

  it('keeps a failed fanout finalization recoverable until retry completes it', async () => {
    const actions = [action('clear-a', 'clear', 'venue-a')];
    const outbox = {
      update: vi.fn().mockResolvedValue(undefined),
      updateByOperationId: vi.fn().mockResolvedValue(undefined),
      claimRecoverable: vi.fn().mockResolvedValue([{ ...row('finalizing', actions), claimToken: 'recovery-claim' }]),
      releaseClaim: vi.fn().mockResolvedValue(undefined),
    };
    const boundary: TradingProfileSagaBoundary = {
      invoke: vi.fn()
        .mockResolvedValueOnce({ kind: 'transport_error', message: 'finalize unavailable', retryable: true })
        .mockResolvedValueOnce(success()),
    };
    const saga = new TradingProfileReconciliationSaga(outbox as never, boundary);
    const operation = { operationId: 'operation-1', ownerId: 'owner-1', actorId: 'agent-1' };

    await expect(saga.finalize(operation)).rejects.toThrow('finalize unavailable');
    expect(outbox.updateByOperationId).toHaveBeenCalledWith('operation-1', 'finalizing', 'finalize unavailable');

    await expect(saga.recover(10)).resolves.toEqual({ recovered: 1, failed: 0 });

    expect(vi.mocked(boundary.invoke).mock.calls.map(([call]) => call.toolName)).toEqual([
      'finalize_agent_trading_profile_change',
      'finalize_agent_trading_profile_change',
    ]);
    expect(outbox.update).toHaveBeenCalledWith('outbox-1', 'completed', actions);
    expect(outbox.releaseClaim).toHaveBeenCalledWith('operation-1', 'recovery-claim');
  });

  it.each([
    ['finalize', {}, 'finalizing'],
    ['finalize', { operationId: 'different-operation' }, 'finalizing'],
    ['rollback', {}, 'rollback_pending'],
    ['rollback', { operationId: 'different-operation' }, 'rollback_pending'],
    ['resume', {}, 'rollback_pending'],
    ['resume', { operationId: 'different-operation' }, 'rollback_pending'],
  ] as const)('keeps an invalid %s response recoverable instead of making a false outbox transition', async (operation, payload, safeState) => {
    const actions = [action('set-a', 'set', 'venue-a')];
    const outbox = {
      update: vi.fn().mockResolvedValue(undefined),
      updateByOperationId: vi.fn().mockResolvedValue(undefined),
      claimRecoverable: vi.fn().mockResolvedValue([
        { ...row(operation === 'finalize' ? 'local_committed' : 'pending_remote', actions), claimToken: 'recovery-claim' },
      ]),
      releaseClaim: vi.fn().mockResolvedValue(undefined),
    };
    const boundary: TradingProfileSagaBoundary = {
      invoke: vi.fn(async ({ toolName }) => {
        if (toolName === `${operation}_agent_trading_profile_change`) {
          return { kind: 'success', requestId: 'request-1', correlationId: 'correlation-1', payload };
        }
        return success();
      }),
    };
    const saga = new TradingProfileReconciliationSaga(outbox as never, boundary);

    await expect(saga.recover(10)).resolves.toEqual({ recovered: 0, failed: 1 });

    expect(outbox.update).toHaveBeenCalledWith('outbox-1', safeState, actions, expect.stringContaining('response'));
    expect(outbox.update).not.toHaveBeenCalledWith('outbox-1', 'completed', actions);
    expect(outbox.update).not.toHaveBeenCalledWith('outbox-1', 'failed', actions, expect.any(String));
    expect(outbox.releaseClaim).toHaveBeenCalledWith('operation-1', 'recovery-claim');
  });

  it('retains a recoverable pending state when fanout rollback is uncertain', async () => {
    const outbox = {
      updateByOperationId: vi.fn().mockResolvedValue(undefined),
    };
    const boundary: TradingProfileSagaBoundary = {
      invoke: vi.fn().mockResolvedValue({ kind: 'transport_error', message: 'boundary unavailable', retryable: true }),
    };
    const saga = new TradingProfileReconciliationSaga(outbox as never, boundary);

    await expect(saga.compensate({ operationId: 'operation-1', ownerId: 'owner-1', actorId: 'agent-1' }))
      .rejects.toThrow('boundary unavailable');

    expect(outbox.updateByOperationId).toHaveBeenCalledWith('operation-1', 'rollback_pending', 'boundary unavailable');
  });

  it('durably fails a successfully compensated fanout operation', async () => {
    const outbox = {
      updateByOperationId: vi.fn().mockResolvedValue(undefined),
    };
    const boundary: TradingProfileSagaBoundary = { invoke: vi.fn().mockResolvedValue(success()) };
    const saga = new TradingProfileReconciliationSaga(outbox as never, boundary);

    await saga.compensate({ operationId: 'operation-1', ownerId: 'owner-1', actorId: 'agent-1' });

    expect(outbox.updateByOperationId).toHaveBeenCalledWith('operation-1', 'failed');
  });

  it('compensates when a local callback returns without marking its transaction committed', async () => {
    const actions = [action('set-a', 'set', 'venue-a')];
    const outbox = {
      createOrLoad: vi.fn().mockResolvedValue(row('pending_remote', actions)),
      update: vi.fn().mockResolvedValue(undefined),
      markLocalCommitted: vi.fn().mockResolvedValue(undefined),
      claimLive: vi.fn().mockResolvedValue('live-claim'),
      releaseClaim: vi.fn().mockResolvedValue(undefined),
      claimRecoverable: vi.fn(),
      inTransaction: vi.fn(async (callback) => callback('transaction-handle')),
    };
    const boundary: TradingProfileSagaBoundary = { invoke: vi.fn().mockResolvedValue(success()) };
    const saga = new TradingProfileReconciliationSaga(outbox as never, boundary);

    await expect(saga.execute({
      ownerId: 'owner-1',
      actorId: 'agent-1',
      localMutationId: 'mutation-1',
      plan,
      commitLocal: async () => undefined,
    })).rejects.toThrow('without marking');

    const toolNames = vi.mocked(boundary.invoke).mock.calls.map(([call]) => call.toolName);
    expect(toolNames).toContain('rollback_agent_trading_profile_change');
    expect(toolNames).not.toContain('finalize_agent_trading_profile_change');
  });

  it('surfaces a boundary ceiling violation as a typed TradingProfileCeilingViolationError', async () => {
    const actions = [action('set-a', 'set', 'venue-a')];
    const outbox = {
      createOrLoad: vi.fn().mockResolvedValue(row('pending_remote', actions)),
      update: vi.fn().mockResolvedValue(undefined),
      markLocalCommitted: vi.fn(),
      claimLive: vi.fn().mockResolvedValue('live-claim'),
      releaseClaim: vi.fn().mockResolvedValue(undefined),
      claimRecoverable: vi.fn(),
      inTransaction: vi.fn(async (callback) => callback('transaction-handle')),
    };
    const boundary: TradingProfileSagaBoundary = {
      invoke: vi.fn(async ({ toolName }) => toolName === 'set_agent_trading_profile'
        ? {
          kind: 'failure',
          requestId: 'request-1',
          correlationId: 'correlation-1',
          code: 'validation.invalid_payload',
          message: 'maxOpenPositions cannot exceed the operator ceiling of 50',
          retryable: false,
          details: { errorCode: 'validation.risk_ceiling' },
        } as TradertonClientResult
        : success()),
    };
    const saga = new TradingProfileReconciliationSaga(outbox as never, boundary);
    const commitLocal = vi.fn();

    await expect(saga.execute({
      ownerId: 'owner-1',
      actorId: 'agent-1',
      localMutationId: 'mutation-1',
      plan: { ...plan, clears: [] },
      commitLocal,
    })).rejects.toBeInstanceOf(TradingProfileCeilingViolationError);
  });
});
