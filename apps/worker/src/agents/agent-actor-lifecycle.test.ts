import { describe, expect, it, vi } from 'vitest';
import type { AgentRepository } from '@herobids/db';
import type { ExternalBackendClientResult } from '@herobids/domain/external-backend';
import type { ExternalBackendWriteBoundary } from '../external-backend/write-adapter.js';
import { AgentActorLifecycle } from './agent-actor-lifecycle.js';

const SUCCESS: ExternalBackendClientResult = { kind: 'success', requestId: 'r', correlationId: 'c', payload: { ok: true } };

function silentLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
}

function makeBoundary(result: ExternalBackendClientResult | (() => Promise<ExternalBackendClientResult>) = SUCCESS) {
  const invokeAndAwait = vi.fn(async () => (typeof result === 'function' ? result() : result));
  const invoke = vi.fn(async () => SUCCESS);
  return { boundary: { invoke, invokeAndAwait } as unknown as ExternalBackendWriteBoundary, invokeAndAwait };
}

function makeRepo(overrides: {
  agent?: { userId: string | null } | null;
  currentSession?: { id: string } | null;
} = {}) {
  const getAgent = vi.fn(async () => (overrides.agent === undefined ? { userId: 'owner-1' } : overrides.agent));
  const getCurrentSession = vi.fn(async () => overrides.currentSession ?? null);
  return { getAgent, getCurrentSession } as unknown as Pick<AgentRepository, 'getAgent' | 'getCurrentSession'>;
}

function build(options: {
  boundary?: ExternalBackendWriteBoundary | undefined;
  invokeAndAwait?: ReturnType<typeof vi.fn>;
  repo?: Pick<AgentRepository, 'getAgent' | 'getCurrentSession'>;
  venueAccountId?: string | null;
} = {}) {
  const resolveVenueAccountId = vi.fn(async () => options.venueAccountId === undefined ? 'venue-1' : options.venueAccountId);
  const lifecycle = new AgentActorLifecycle({
    boundary: 'boundary' in options ? options.boundary : (options.boundary ?? makeBoundary().boundary),
    agentRepo: options.repo ?? makeRepo(),
    resolveVenueAccountId,
    deadlineMs: 5000,
    logger: silentLogger(),
  });
  return { lifecycle, resolveVenueAccountId };
}

describe('AgentActorLifecycle', () => {
  it('starts the actor with the resolved venueAccountId and an agent subject', async () => {
    const { boundary, invokeAndAwait } = makeBoundary();
    const { lifecycle } = build({ boundary, venueAccountId: 'venue-7' });

    await lifecycle.start('agent-1', 'session_active');

    expect(invokeAndAwait).toHaveBeenCalledTimes(1);
    const call = invokeAndAwait.mock.calls[0]![0];
    expect(call.toolName).toBe('start_agent_actor');
    expect(call.payload).toEqual({ venueAccountId: 'venue-7' });
    expect(call.subject).toEqual({ ownerId: 'owner-1', actor: { type: 'agent', id: 'agent-1' } });
  });

  it('uses a fresh idempotency key for every call', async () => {
    const { boundary, invokeAndAwait } = makeBoundary();
    const { lifecycle } = build({ boundary });

    await lifecycle.start('agent-1', 'a');
    await lifecycle.start('agent-1', 'b');

    const keyA = invokeAndAwait.mock.calls[0]![0].idempotencyKey;
    const keyB = invokeAndAwait.mock.calls[1]![0].idempotencyKey;
    expect(keyA).not.toBe(keyB);
  });

  it('skips start for an agent with no ready trading connection', async () => {
    const { boundary, invokeAndAwait } = makeBoundary();
    const { lifecycle } = build({ boundary, venueAccountId: null });

    await lifecycle.start('agent-1', 'session_active');

    expect(invokeAndAwait).not.toHaveBeenCalled();
  });

  it('never rejects when the boundary fails or times out', async () => {
    const failing = makeBoundary(async () => { throw new Error('boundary exploded'); });
    const { lifecycle } = build({ boundary: failing.boundary });

    await expect(lifecycle.start('agent-1', 'session_active')).resolves.toBeUndefined();
    await expect(lifecycle.stop('agent-1', 'session_stopped')).resolves.toBeUndefined();
  });

  it('skips stop when a newer session is live', async () => {
    const { boundary, invokeAndAwait } = makeBoundary();
    const { lifecycle } = build({ boundary, repo: makeRepo({ currentSession: { id: 'session-new' } }) });

    await lifecycle.stop('agent-1', 'session_stopped', 'session-old');

    expect(invokeAndAwait).not.toHaveBeenCalled();
  });

  it('stops when the stopped session is the current one or none is live', async () => {
    const live = makeBoundary();
    const l1 = build({ boundary: live.boundary, repo: makeRepo({ currentSession: { id: 'session-1' } }) });
    await l1.lifecycle.stop('agent-1', 'session_stopped', 'session-1');
    expect(live.invokeAndAwait).toHaveBeenCalledTimes(1);
    expect(live.invokeAndAwait.mock.calls[0]![0].toolName).toBe('stop_agent_actor');

    const none = makeBoundary();
    const l2 = build({ boundary: none.boundary, repo: makeRepo({ currentSession: null }) });
    await l2.lifecycle.stop('agent-1', 'session_stopped', 'session-old');
    expect(none.invokeAndAwait).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the boundary is not configured', async () => {
    const { lifecycle, resolveVenueAccountId } = build({ boundary: undefined });

    await lifecycle.start('agent-1', 'session_active');
    await lifecycle.stop('agent-1', 'session_stopped');

    expect(resolveVenueAccountId).not.toHaveBeenCalled();
  });

  it('skips start when the agent has no owner', async () => {
    const { boundary, invokeAndAwait } = makeBoundary();
    const { lifecycle } = build({ boundary, repo: makeRepo({ agent: { userId: null } }) });

    await lifecycle.start('agent-1', 'session_active');

    expect(invokeAndAwait).not.toHaveBeenCalled();
  });
});
