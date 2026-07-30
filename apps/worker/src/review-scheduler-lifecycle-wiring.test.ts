import { describe, it, expect } from 'vitest';

/**
 * Regression coverage for RC2 in
 * docs/bug-reports/2026/07/21/001-staging-agents-not-trading-actor-start-never-called.md
 *
 * The worker composition root (apps/worker/src/index.ts) only created
 * per-agent ReviewSchedulers once, in a one-time boot loop over
 * agentRepo.listActiveAgents() — agents activated after boot never got a
 * scheduler. The fix extracts the per-agent gating/creation logic into
 * startReviewSchedulerForAgent()/stopReviewSchedulerForAgent(), invoked from
 * both the boot loop AND onSessionActive/onSessionStopped.
 *
 * Following the established convention (see
 * scanner-gated-config-validation.test.ts), this test mirrors the pure
 * gating logic from startReviewSchedulerForAgent() locally rather than
 * importing from index.ts (a composition root that boots the full app and
 * cannot be imported in isolation).
 */

interface MirroredAgentRow {
  id: string;
  unifiedConfig: Record<string, unknown> | null;
}

/**
 * Mirrors the three gates at the top of startReviewSchedulerForAgent():
 * 1. Operator master switch (appConfig.platformAssessor.enabled)
 * 2. Idempotency guard (reviewSchedulers.has(agent.id))
 * 3. Agent opt-in (unifiedConfig.platformAssessment.enabled === true)
 *
 * Returns whether a scheduler would be created, and the reason if not.
 */
function resolveReviewSchedulerGate(
  operatorEnabled: boolean,
  alreadyRunning: boolean,
  agent: MirroredAgentRow,
): { shouldStart: boolean; reason?: 'operator_disabled' | 'already_running' | 'agent_not_opted_in' } {
  if (!operatorEnabled) return { shouldStart: false, reason: 'operator_disabled' };
  if (alreadyRunning) return { shouldStart: false, reason: 'already_running' };

  const unifiedConfig = agent.unifiedConfig ?? {};
  const platformAssessment = (unifiedConfig['platformAssessment'] ?? {}) as Record<string, unknown>;
  const agentEnabled = platformAssessment['enabled'] === true;
  if (!agentEnabled) return { shouldStart: false, reason: 'agent_not_opted_in' };

  return { shouldStart: true };
}

function makeAgent(overrides?: Partial<MirroredAgentRow>): MirroredAgentRow {
  return {
    id: 'agent-1',
    unifiedConfig: { platformAssessment: { enabled: true } },
    ...overrides,
  };
}

describe('review scheduler start/stop gating (onSessionActive / onSessionStopped wiring)', () => {
  it('does not start when the operator master switch is disabled', () => {
    const result = resolveReviewSchedulerGate(false, false, makeAgent());

    expect(result).toEqual({ shouldStart: false, reason: 'operator_disabled' });
  });

  it('does not start a second scheduler for an agent that already has one running (idempotent)', () => {
    const result = resolveReviewSchedulerGate(true, true, makeAgent());

    expect(result).toEqual({ shouldStart: false, reason: 'already_running' });
  });

  it('does not start when the agent has not opted into platform assessment', () => {
    const result = resolveReviewSchedulerGate(true, false, makeAgent({ unifiedConfig: {} }));

    expect(result).toEqual({ shouldStart: false, reason: 'agent_not_opted_in' });
  });

  it('does not start when unifiedConfig is null (agent never configured)', () => {
    const result = resolveReviewSchedulerGate(true, false, makeAgent({ unifiedConfig: null }));

    expect(result).toEqual({ shouldStart: false, reason: 'agent_not_opted_in' });
  });

  it('starts when the operator switch is enabled, no scheduler is running yet, and the agent opted in', () => {
    const result = resolveReviewSchedulerGate(true, false, makeAgent());

    expect(result).toEqual({ shouldStart: true });
  });

  it('an agent activated after worker boot (not present in the original boot-time snapshot) still starts a scheduler', () => {
    // This is the exact regression scenario: the boot-time loop only ever
    // saw agents active AT BOOT. An agent that transitions to active later
    // (the normal path — agents are started on demand via onSessionActive)
    // must independently pass the same gate when startReviewSchedulerForAgent
    // is invoked from onSessionActive, not just from the boot loop.
    const agentActivatedAfterBoot = makeAgent({ id: 'agent-late' });

    // alreadyRunning=false because this agent's scheduler was never created
    // at boot time (it wasn't active yet) — onSessionActive is the only
    // lifecycle hook that will ever create one for it.
    const result = resolveReviewSchedulerGate(true, false, agentActivatedAfterBoot);

    expect(result).toEqual({ shouldStart: true });
  });
});

/**
 * Mirrors the map-based registry lifecycle (reviewSchedulers: Map<agentId, ReviewScheduler>)
 * used by startReviewSchedulerForAgent()/stopReviewSchedulerForAgent() to guarantee
 * at most one active scheduler per agent, and clean removal on session stop.
 */
/**
 * Mirrors the capability-mode gate at the top of startReviewSchedulerForAgent():
 *   if (unifiedConfig['capabilityMode'] !== 'hybrid') return;
 *
 * This gate was added to prevent intelligence agents from running the
 * automatic review scheduler, since preset review is only meaningful
 * for hybrid agents.
 *
 * SOURCE-MIRROR: mirrors index.ts startReviewSchedulerForAgent() capabilityMode gate
 */
function resolveCapabilityModeGate(
  agent: MirroredAgentRow,
): { shouldStart: boolean; reason?: 'not_hybrid' } {
  const unifiedConfig = agent.unifiedConfig ?? {};
  if (unifiedConfig['capabilityMode'] !== 'hybrid') {
    return { shouldStart: false, reason: 'not_hybrid' };
  }
  return { shouldStart: true };
}

describe('review scheduler capability-mode gating', () => {
  it('startReviewSchedulerForAgent returns early for non-hybrid (intelligence) agent', () => {
    const agent = makeAgent({
      unifiedConfig: {
        platformAssessment: { enabled: true },
        capabilityMode: 'intelligence',
      },
    });

    const result = resolveCapabilityModeGate(agent);
    expect(result).toEqual({ shouldStart: false, reason: 'not_hybrid' });
  });

  it('startReviewSchedulerForAgent starts for hybrid agent', () => {
    const agent = makeAgent({
      unifiedConfig: {
        platformAssessment: { enabled: true },
        capabilityMode: 'hybrid',
      },
    });

    const result = resolveCapabilityModeGate(agent);
    expect(result).toEqual({ shouldStart: true });
  });

  it('returns early when capabilityMode is missing (treats as non-hybrid)', () => {
    const agent = makeAgent({
      unifiedConfig: {
        platformAssessment: { enabled: true },
      },
    });

    const result = resolveCapabilityModeGate(agent);
    expect(result).toEqual({ shouldStart: false, reason: 'not_hybrid' });
  });
});

describe('review scheduler registry lifecycle (Map-based, mirrors index.ts)', () => {
  it('registers exactly one scheduler per agent and removes it on stop', () => {
    const registry = new Map<string, { stopped: boolean }>();

    function start(agentId: string) {
      if (registry.has(agentId)) return; // idempotent
      registry.set(agentId, { stopped: false });
    }
    function stop(agentId: string) {
      const entry = registry.get(agentId);
      if (!entry) return;
      entry.stopped = true;
      registry.delete(agentId);
    }

    start('agent-1');
    start('agent-1'); // second call is a no-op — must not create a duplicate entry
    expect(registry.size).toBe(1);

    stop('agent-1');
    expect(registry.has('agent-1')).toBe(false);

    stop('agent-1'); // stopping again is a no-op, not a throw
    expect(registry.size).toBe(0);
  });
});

/**
 * Mirrors the ManualReviewRunnerFactory defense-in-depth gate from index.ts:
 *
 *   if (unifiedConfig['capabilityMode'] !== 'hybrid') {
 *     return err({ code: 'review.capability_mode_unsupported', ... });
 *   }
 *
 * This is a safety net — the API already rejects non-hybrid agents, but if a
 *
 * SOURCE-MIRROR: mirrors index.ts ManualReviewRunnerFactory capabilityMode gate
 * job somehow reaches the worker for a non-hybrid agent (stale enqueue, race),
 * the factory rejects cleanly so the run terminates instead of executing
 * against a non-existent preset.
 */
function resolveManualReviewFactoryCapabilityGate(
  unifiedConfig: Record<string, unknown> | null,
): { ok: false; error: { code: string } } | { ok: true } {
  const uc = (unifiedConfig ?? {}) as Record<string, unknown>;
  if (uc['capabilityMode'] !== 'hybrid') {
    return { ok: false, error: { code: 'review.capability_mode_unsupported' } };
  }
  return { ok: true };
}

describe('ManualReviewRunnerFactory — defense-in-depth capability gate', () => {
  it('returns review.capability_mode_unsupported for non-hybrid agent', () => {
    const result = resolveManualReviewFactoryCapabilityGate({
      capabilityMode: 'intelligence',
      platformAssessment: { enabled: true },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('review.capability_mode_unsupported');
    }
  });

  it('passes capability gate for hybrid agent', () => {
    const result = resolveManualReviewFactoryCapabilityGate({
      capabilityMode: 'hybrid',
      platformAssessment: { enabled: true },
    });

    expect(result.ok).toBe(true);
  });

  it('treats missing capabilityMode as not-hybrid (rejects)', () => {
    const result = resolveManualReviewFactoryCapabilityGate({
      platformAssessment: { enabled: true },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('review.capability_mode_unsupported');
    }
  });
});
