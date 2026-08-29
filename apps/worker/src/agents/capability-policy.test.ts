import { describe, expect, it } from 'vitest';
import { buildCapabilityGrants, buildCapabilityPolicyEngine } from './capability-policy.js';

describe('buildCapabilityPolicyEngine', () => {
  it('merges per-runtime overrides onto the default capability policy', () => {
    const engine = buildCapabilityPolicyEngine({
      execute_code: {
        enabled: false,
        tier: 'direct',
        limits: { timeoutMs: 5_000 },
      },
    });

    expect(engine.getGrant('execute_code')).toEqual(
      expect.objectContaining({
        capability: 'execute_code',
        enabled: false,
        tier: 'direct',
        limits: expect.objectContaining({
          timeoutMs: 5_000,
          maxConcurrent: 1,
        }),
      }),
    );
  });

  it('preserves session rate limits when grants are refreshed in place', () => {
    const engine = buildCapabilityPolicyEngine({
      execute_code: {
        enabled: true,
        tier: 'direct',
        limits: { maxPerMinute: 1 },
      },
    });

    expect(engine.checkAccess('execute_code', 'agent-1', 'session-1')).toBeUndefined();
    engine.recordStart('execute_code', 'session-1');

    expect(engine.checkAccess('execute_code', 'agent-1', 'session-1')).toBe('rate_limit_exceeded');

    engine.replaceGrants(buildCapabilityGrants({
      execute_code: {
        enabled: true,
        tier: 'direct',
        limits: { maxPerMinute: 1, timeoutMs: 5_000 },
      },
    }));

    expect(engine.getGrant('execute_code')).toEqual(
      expect.objectContaining({
        limits: expect.objectContaining({ timeoutMs: 5_000, maxPerMinute: 1 }),
      }),
    );
    expect(engine.checkAccess('execute_code', 'agent-1', 'session-1')).toBe('rate_limit_exceeded');
  });
});


// ── manage_agent_skills in DEFAULT_CAPABILITY_GRANTS ─────────────────────────

describe('DEFAULT_CAPABILITY_GRANTS — manage_agent_skills', () => {
  it('includes manage_agent_skills as a brokered, enabled grant', () => {
    // Build engine with no overrides → uses DEFAULT_CAPABILITY_GRANTS
    const engine = buildCapabilityPolicyEngine();
    const grant = engine.getGrant('manage_agent_skills');

    expect(grant).toBeDefined();
    expect(grant).toEqual(expect.objectContaining({
      capability: 'manage_agent_skills',
      tier: 'brokered',
      enabled: true,
    }));
  });

  it('has correct rate limits for manage_agent_skills', () => {
    const engine = buildCapabilityPolicyEngine();
    const grant = engine.getGrant('manage_agent_skills');

    expect(grant!.limits).toEqual(expect.objectContaining({
      maxPerMinute: 10,
      maxConcurrent: 1,
      timeoutMs: 30_000,
    }));
  });

  it('allows access to manage_agent_skills with default grants', () => {
    const engine = buildCapabilityPolicyEngine();
    const denied = engine.checkAccess('manage_agent_skills', 'agent-1', 'session-1');
    expect(denied).toBeUndefined(); // No denial reason → access allowed
  });

  it('allows per-agent override of manage_agent_skills', () => {
    const engine = buildCapabilityPolicyEngine({
      manage_agent_skills: {
        enabled: false,
        tier: 'brokered',
        limits: { maxPerMinute: 5 },
      },
    });

    const grant = engine.getGrant('manage_agent_skills');
    expect(grant).toEqual(expect.objectContaining({
      capability: 'manage_agent_skills',
      enabled: false,
      tier: 'brokered',
    }));
    expect(grant!.limits).toEqual(expect.objectContaining({
      maxPerMinute: 5,
      maxConcurrent: 1,  // inherited from default
      timeoutMs: 30_000, // inherited from default
    }));
  });

  it('denies access when manage_agent_skills is disabled via override', () => {
    const engine = buildCapabilityPolicyEngine({
      manage_agent_skills: {
        enabled: false,
        tier: 'brokered',
      },
    });

    const denied = engine.checkAccess('manage_agent_skills', 'agent-1', 'session-1');
    expect(denied).toBe('capability_disabled');
  });
});

describe('buildCapabilityGrants — manage_agent_skills', () => {
  it('includes manage_agent_skills in default grants when no overrides', () => {
    const grants = buildCapabilityGrants();
    const skillsGrant = grants.find((g) => g.capability === 'manage_agent_skills');

    expect(skillsGrant).toBeDefined();
    expect(skillsGrant).toEqual(expect.objectContaining({
      capability: 'manage_agent_skills',
      tier: 'brokered',
      enabled: true,
    }));
  });

  it('merges per-agent manage_agent_skills override with default limits', () => {
    const grants = buildCapabilityGrants({
      manage_agent_skills: {
        capability: 'manage_agent_skills',
        tier: 'brokered',
        enabled: false,
        limits: { maxPerMinute: 2 },
      },
    });
    const skillsGrant = grants.find((g) => g.capability === 'manage_agent_skills');

    expect(skillsGrant).toEqual(expect.objectContaining({
      capability: 'manage_agent_skills',
      enabled: false,
      limits: expect.objectContaining({
        maxPerMinute: 2,
        maxConcurrent: 1,
        timeoutMs: 30_000,
      }),
    }));
  });
});
