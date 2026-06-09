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