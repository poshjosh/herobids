import { describe, expect, it, vi } from 'vitest';
import type { ExternalBackendClientResult } from '@herobids/domain/external-backend';
import { createAgentActorLifecycleHook, type AgentActorLifecycleClient } from './agent-actor-lifecycle-hook.js';
import type { ProfilesCommittedEvent } from './trading-profile-reconciliation-saga.js';

const SUCCESS: ExternalBackendClientResult = { kind: 'success', requestId: 'r', correlationId: 'c', payload: { ok: true } };

function silentLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

function makeClient(result: ExternalBackendClientResult | (() => Promise<ExternalBackendClientResult>) = SUCCESS) {
  const invoke = vi.fn(async () => (typeof result === 'function' ? result() : result));
  return { client: { invoke } as unknown as AgentActorLifecycleClient, invoke };
}

/** Fake db whose AgentRepository.getCurrentSession resolves to `session`. */
function makeDb(session: { id: string } | null) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (session ? [session] : []) }),
      }),
    }),
  } as never;
}

function event(overrides: Partial<ProfilesCommittedEvent> = {}): ProfilesCommittedEvent {
  return {
    ownerId: 'owner-1',
    actorId: 'agent-1',
    upserted: 1,
    cleared: 0,
    remainingProfiles: 1,
    executionVenueAccountId: 'venue-1',
    ...overrides,
  };
}

describe('createAgentActorLifecycleHook', () => {
  it('stops the actor when the last profile is cleared and no session is live', async () => {
    const { client, invoke } = makeClient();
    const hook = createAgentActorLifecycleHook({ client, db: makeDb(null), timeoutMs: 5000, logger: silentLogger() });

    await hook.onProfilesCommitted!(event({ upserted: 0, cleared: 2, remainingProfiles: 0, executionVenueAccountId: null }));

    expect(invoke).toHaveBeenCalledTimes(1);
    const call = invoke.mock.calls[0]![0];
    expect(call.toolName).toBe('stop_agent_actor');
    expect(call.payload).toEqual({});
    expect(call.subject).toEqual({ ownerId: 'owner-1', actor: { type: 'agent', id: 'agent-1' } });
  });

  it('does not stop the actor after a clear when a session is live (D7 guard)', async () => {
    const { client, invoke } = makeClient();
    const hook = createAgentActorLifecycleHook({ client, db: makeDb({ id: 's1' }), timeoutMs: 5000, logger: silentLogger() });

    await hook.onProfilesCommitted!(event({ upserted: 0, cleared: 2, remainingProfiles: 0, executionVenueAccountId: null }));

    expect(invoke).not.toHaveBeenCalled();
  });

  it('starts the actor after an upsert on an agent with a live session', async () => {
    const { client, invoke } = makeClient();
    const hook = createAgentActorLifecycleHook({ client, db: makeDb({ id: 's1' }), timeoutMs: 5000, logger: silentLogger() });

    await hook.onProfilesCommitted!(event());

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]![0].toolName).toBe('start_agent_actor');
    expect(invoke.mock.calls[0]![0].payload).toEqual({ venueAccountId: 'venue-1' });
  });

  it('does not start the actor when the agent has no live session', async () => {
    const { client, invoke } = makeClient();
    const hook = createAgentActorLifecycleHook({ client, db: makeDb(null), timeoutMs: 5000, logger: silentLogger() });

    await hook.onProfilesCommitted!(event());

    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not stop when profiles remain after a partial revoke', async () => {
    const { client, invoke } = makeClient();
    const hook = createAgentActorLifecycleHook({ client, db: makeDb({ id: 's1' }), timeoutMs: 5000, logger: silentLogger() });

    // cleared > 0 but profiles remain → neither a stop nor (no upsert) a start.
    await hook.onProfilesCommitted!(event({ upserted: 0, cleared: 1, remainingProfiles: 2, executionVenueAccountId: null }));

    expect(invoke).not.toHaveBeenCalled();
  });

  it('logs and resolves when the boundary call fails', async () => {
    const { client } = makeClient(async () => { throw new Error('boundary down'); });
    const hook = createAgentActorLifecycleHook({ client, db: makeDb({ id: 's1' }), timeoutMs: 5000, logger: silentLogger() });

    await expect(hook.onProfilesCommitted!(event())).resolves.toBeUndefined();
  });

  it('uses a fresh idempotency key per call', async () => {
    const { client, invoke } = makeClient();
    const hook = createAgentActorLifecycleHook({ client, db: makeDb({ id: 's1' }), timeoutMs: 5000, logger: silentLogger() });

    await hook.onProfilesCommitted!(event());
    await hook.onProfilesCommitted!(event());

    expect(invoke.mock.calls[0]![0].idempotencyKey).not.toBe(invoke.mock.calls[1]![0].idempotencyKey);
  });
});
