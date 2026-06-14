import { describe, it, expect, vi } from 'vitest';

/**
 * Tests for the session-to-actor ownership logic in the worker's onSessionStopped callback.
 * Validates that:
 * 1. A late stop for session A does NOT kill session B's actor (the race condition fix).
 * 2. Only the owning session can deregister the actor.
 * 3. Overlapping start/stop sequences don't orphan actors.
 */

interface FakeActor {
  id: string;
  stop: ReturnType<typeof vi.fn>;
}

function createOwnershipTestHarness() {
  const actorRegistry = new Map<string, FakeActor>();
  const actorOwnerSessions = new Map<string, string>();
  const pendingActorSessions = new Map<string, string>();
  const log: string[] = [];

  function onSessionActive(agentId: string, sessionId: string, actor: FakeActor) {
    pendingActorSessions.set(agentId, sessionId);
    // Simulate successful registration
    actorRegistry.set(agentId, actor);
    actorOwnerSessions.set(agentId, sessionId);
    pendingActorSessions.delete(agentId);
    log.push(`registered:${agentId}:${sessionId}`);
  }

  function onSessionStopped(agentId: string, sessionId: string) {
    // Clear pending if this session was the one pending
    if (pendingActorSessions.get(agentId) === sessionId) {
      pendingActorSessions.delete(agentId);
    }

    // Ownership guard: only the owning session can stop the actor
    const ownerSession = actorOwnerSessions.get(agentId);
    if (ownerSession && ownerSession !== sessionId) {
      log.push(`ignored-stale:${agentId}:${sessionId}:owner=${ownerSession}`);
      return;
    }

    const actor = actorRegistry.get(agentId);
    if (actor) {
      actor.stop();
      actorRegistry.delete(agentId);
      actorOwnerSessions.delete(agentId);
      log.push(`stopped:${agentId}:${sessionId}`);
    }
  }

  return { actorRegistry, actorOwnerSessions, pendingActorSessions, onSessionActive, onSessionStopped, log };
}

describe('actor session ownership', () => {
  it('stops the actor when the owning session requests stop', () => {
    const h = createOwnershipTestHarness();
    const actor: FakeActor = { id: 'actor-1', stop: vi.fn() };

    h.onSessionActive('agent-1', 'sess-A', actor);
    h.onSessionStopped('agent-1', 'sess-A');

    expect(actor.stop).toHaveBeenCalledTimes(1);
    expect(h.actorRegistry.has('agent-1')).toBe(false);
    expect(h.actorOwnerSessions.has('agent-1')).toBe(false);
  });

  it('does NOT stop the actor when a stale session requests stop (race fix)', () => {
    const h = createOwnershipTestHarness();
    const actorA: FakeActor = { id: 'actor-A', stop: vi.fn() };
    const actorB: FakeActor = { id: 'actor-B', stop: vi.fn() };

    // Session A starts and registers
    h.onSessionActive('agent-1', 'sess-A', actorA);
    // Session B starts and overwrites (normal restart)
    h.onSessionActive('agent-1', 'sess-B', actorB);

    // Late stop arrives for session A (the race condition)
    h.onSessionStopped('agent-1', 'sess-A');

    // Actor B must NOT be stopped
    expect(actorB.stop).not.toHaveBeenCalled();
    expect(h.actorRegistry.get('agent-1')).toBe(actorB);
    expect(h.actorOwnerSessions.get('agent-1')).toBe('sess-B');

    // Actor A's stop was never called (it was already replaced)
    expect(actorA.stop).not.toHaveBeenCalled();
    expect(h.log).toContain('ignored-stale:agent-1:sess-A:owner=sess-B');
  });

  it('correctly stops session B actor when session B stop arrives after stale A stop', () => {
    const h = createOwnershipTestHarness();
    const actorA: FakeActor = { id: 'actor-A', stop: vi.fn() };
    const actorB: FakeActor = { id: 'actor-B', stop: vi.fn() };

    h.onSessionActive('agent-1', 'sess-A', actorA);
    h.onSessionActive('agent-1', 'sess-B', actorB);

    // Stale stop for A is ignored
    h.onSessionStopped('agent-1', 'sess-A');
    expect(actorB.stop).not.toHaveBeenCalled();

    // Real stop for B works
    h.onSessionStopped('agent-1', 'sess-B');
    expect(actorB.stop).toHaveBeenCalledTimes(1);
    expect(h.actorRegistry.has('agent-1')).toBe(false);
  });

  it('handles stop arriving while a new session is pending (different session)', () => {
    const h = createOwnershipTestHarness();
    const actorA: FakeActor = { id: 'actor-A', stop: vi.fn() };

    h.onSessionActive('agent-1', 'sess-A', actorA);

    // Simulate B starting (pending but not yet registered)
    h.pendingActorSessions.set('agent-1', 'sess-B');

    // Stop arrives for A while B is pending
    h.onSessionStopped('agent-1', 'sess-A');

    // A's actor should be stopped because A still owns it
    expect(actorA.stop).toHaveBeenCalledTimes(1);
    expect(h.actorRegistry.has('agent-1')).toBe(false);
    // pendingActorSessions for B should NOT be cleared
    expect(h.pendingActorSessions.get('agent-1')).toBe('sess-B');
  });

  it('ignores stop for unknown session when no actor is registered', () => {
    const h = createOwnershipTestHarness();

    h.onSessionStopped('agent-1', 'sess-unknown');

    expect(h.actorRegistry.has('agent-1')).toBe(false);
    expect(h.log).toHaveLength(0);
  });
});
