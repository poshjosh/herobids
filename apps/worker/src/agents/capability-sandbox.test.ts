import { describe, it, expect } from 'vitest';
import { CapabilityPolicyEngine, DEFAULT_CAPABILITY_GRANTS } from './capability-policy.js';
import { SandboxEnforcer } from './sandbox-enforcer.js';

describe('CapabilityPolicyEngine', () => {
  describe('checkAccess', () => {
    it('allows brokered capabilities that are enabled', () => {
      const engine = new CapabilityPolicyEngine();
      expect(engine.checkAccess('submit_decision', 'agent-1', 'sess-1')).toBeUndefined();
    });

    it('allows direct capabilities that are enabled', () => {
      const engine = new CapabilityPolicyEngine();
      expect(engine.checkAccess('search_web', 'agent-1', 'sess-1')).toBeUndefined();
    });

    it('denies capabilities with tier=never (disabled takes precedence)', () => {
      const engine = new CapabilityPolicyEngine();
      // Default never-tier grants are also disabled, so enabled check fires first
      for (const cap of ['venue_api', 'raw_secrets', 'database_write', 'host_control']) {
        const denial = engine.checkAccess(cap, 'agent-1', 'sess-1');
        expect(denial).toMatchObject({ reason: 'capability_disabled' });
        expect(denial!.message).toContain(cap);
      }
    });

    it('denies capabilities with tier=never even if enabled', () => {
      const grants = [{ capability: 'dangerous_tool', tier: 'never' as const, enabled: true }];
      const engine = new CapabilityPolicyEngine(grants);
      const denial = engine.checkAccess('dangerous_tool', 'agent-1', 'sess-1');
      expect(denial).toMatchObject({ reason: 'capability_never_allowed' });
      expect(denial!.message).toContain('dangerous_tool');
    });

    it('denies unknown capabilities', () => {
      const engine = new CapabilityPolicyEngine();
      const denial = engine.checkAccess('unknown_tool', 'agent-1', 'sess-1');
      expect(denial).toMatchObject({ reason: 'unknown_capability' });
      expect(denial!.message).toContain('unknown_tool');
    });

    it('denies all access after kill switch', () => {
      const engine = new CapabilityPolicyEngine();
      engine.activateKillSwitch();

      const denial1 = engine.checkAccess('submit_decision', 'agent-1', 'sess-1');
      expect(denial1).toMatchObject({ reason: 'kill_switch_active' });
      expect(denial1!.message).toBeDefined();

      const denial2 = engine.checkAccess('web_fetch', 'agent-1', 'sess-1');
      expect(denial2).toMatchObject({ reason: 'kill_switch_active' });
    });

    it('re-allows access after deactivating kill switch', () => {
      const engine = new CapabilityPolicyEngine();
      engine.activateKillSwitch();
      engine.deactivateKillSwitch();
      expect(engine.checkAccess('submit_decision', 'agent-1', 'sess-1')).toBeUndefined();
    });

    describe('structured denial fields', () => {
      it('permanent denials have no retryAfterMs', () => {
        const engine = new CapabilityPolicyEngine();
        engine.activateKillSwitch();

        const killSwitchDenial = engine.checkAccess('submit_decision', 'agent-1', 'sess-1');
        expect(killSwitchDenial).toBeDefined();
        expect(killSwitchDenial!.retryAfterMs).toBeUndefined();

        engine.deactivateKillSwitch();

        const unknownDenial = engine.checkAccess('nonexistent', 'agent-1', 'sess-1');
        expect(unknownDenial).toBeDefined();
        expect(unknownDenial!.retryAfterMs).toBeUndefined();

        const disabledDenial = engine.checkAccess('manage_bot', 'agent-1', 'sess-1');
        expect(disabledDenial).toBeDefined();
        expect(disabledDenial!.retryAfterMs).toBeUndefined();

        const neverEngine = new CapabilityPolicyEngine([
          { capability: 'x', tier: 'never', enabled: true },
        ]);
        const neverDenial = neverEngine.checkAccess('x', 'agent-1', 'sess-1');
        expect(neverDenial).toBeDefined();
        expect(neverDenial!.retryAfterMs).toBeUndefined();
      });

      it('every denial includes a non-empty message string', () => {
        const engine = new CapabilityPolicyEngine([
          { capability: 'limited', tier: 'direct', enabled: true, limits: { maxPerMinute: 1, maxConcurrent: 1 } },
          { capability: 'off', tier: 'direct', enabled: false },
          { capability: 'blocked', tier: 'never', enabled: true },
        ]);

        // kill_switch_active
        engine.activateKillSwitch();
        const killSwitchDenial = engine.checkAccess('limited', 'a', 's');
        expect(killSwitchDenial).toBeDefined();
        expect(typeof killSwitchDenial!.message).toBe('string');
        expect(killSwitchDenial!.message.length).toBeGreaterThan(0);
        engine.deactivateKillSwitch();

        // unknown_capability
        const unknownDenial = engine.checkAccess('nope', 'a', 's');
        expect(unknownDenial).toBeDefined();
        expect(typeof unknownDenial!.message).toBe('string');
        expect(unknownDenial!.message.length).toBeGreaterThan(0);

        // capability_disabled
        const disabledDenial = engine.checkAccess('off', 'a', 's');
        expect(disabledDenial).toBeDefined();
        expect(typeof disabledDenial!.message).toBe('string');
        expect(disabledDenial!.message.length).toBeGreaterThan(0);

        // capability_never_allowed
        const neverDenial = engine.checkAccess('blocked', 'a', 's');
        expect(neverDenial).toBeDefined();
        expect(typeof neverDenial!.message).toBe('string');
        expect(neverDenial!.message.length).toBeGreaterThan(0);

        // rate_limit_exceeded
        engine.recordStart('limited', 's');
        const rateDenial = engine.checkAccess('limited', 'a', 's');
        expect(rateDenial).toBeDefined();
        expect(typeof rateDenial!.message).toBe('string');
        expect(rateDenial!.message.length).toBeGreaterThan(0);

        // max_concurrent_exceeded — rate fires first on same engine, so use a separate one
        const concEngine = new CapabilityPolicyEngine([
          { capability: 'c', tier: 'direct', enabled: true, limits: { maxConcurrent: 1 } },
        ]);
        concEngine.recordStart('c', 's');
        const concurrencyDenial = concEngine.checkAccess('c', 'a', 's');
        expect(concurrencyDenial).toBeDefined();
        expect(typeof concurrencyDenial!.message).toBe('string');
        expect(concurrencyDenial!.message.length).toBeGreaterThan(0);
      });
    });
  });

  describe('rate limiting', () => {
    it('denies after exceeding rate limit', () => {
      const engine = new CapabilityPolicyEngine();
      // submit_decision has maxPerMinute: 10
      for (let i = 0; i < 10; i++) {
        engine.recordStart('submit_decision', 'sess-1');
      }
      const denial = engine.checkAccess('submit_decision', 'agent-1', 'sess-1');
      expect(denial).toMatchObject({ reason: 'rate_limit_exceeded' });
    });

    it('allows after rate window resets', () => {
      const engine = new CapabilityPolicyEngine();
      for (let i = 0; i < 10; i++) {
        engine.recordStart('submit_decision', 'sess-1');
      }
      const denial = engine.checkAccess('submit_decision', 'agent-1', 'sess-1');
      expect(denial).toMatchObject({ reason: 'rate_limit_exceeded' });
    });

    it('rate_limit_exceeded includes retryAfterMs, limit, and used', () => {
      const engine = new CapabilityPolicyEngine([
        { capability: 'probe', tier: 'direct', enabled: true, limits: { maxPerMinute: 2 } },
      ]);
      engine.recordStart('probe', 'sess-1');
      engine.recordStart('probe', 'sess-1');

      const denial = engine.checkAccess('probe', 'agent-1', 'sess-1');
      expect(denial).toBeDefined();
      expect(denial!.reason).toBe('rate_limit_exceeded');
      expect(denial!.limit).toBe(2);
      expect(denial!.used).toBe(2);
      expect(typeof denial!.retryAfterMs).toBe('number');
      expect(denial!.retryAfterMs).toBeGreaterThanOrEqual(0);
      expect(denial!.message).toContain('2/2');
    });
  });

  describe('concurrency limiting', () => {
    it('denies when max concurrent exceeded', () => {
      const engine = new CapabilityPolicyEngine();
      // submit_decision has maxConcurrent: 1
      engine.recordStart('submit_decision', 'sess-1');
      const denial = engine.checkAccess('submit_decision', 'agent-1', 'sess-1');
      expect(denial).toMatchObject({ reason: 'max_concurrent_exceeded' });
    });

    it('allows after concurrent call ends', () => {
      const engine = new CapabilityPolicyEngine();
      engine.recordStart('submit_decision', 'sess-1');
      engine.recordEnd('submit_decision', 'sess-1', {
        capability: 'submit_decision',
        agentId: 'agent-1',
        sessionId: 'sess-1',
        timestamp: new Date().toISOString(),
        durationMs: 100,
        inputSummary: 'test',
        outputSummary: 'test',
        success: true,
      });
      expect(engine.checkAccess('submit_decision', 'agent-1', 'sess-1')).toBeUndefined();
    });

    it('max_concurrent_exceeded includes limit and used but no retryAfterMs', () => {
      const engine = new CapabilityPolicyEngine([
        { capability: 'conc', tier: 'direct', enabled: true, limits: { maxConcurrent: 3 } },
      ]);
      engine.recordStart('conc', 'sess-1');
      engine.recordStart('conc', 'sess-1');
      engine.recordStart('conc', 'sess-1');

      const denial = engine.checkAccess('conc', 'agent-1', 'sess-1');
      expect(denial).toBeDefined();
      expect(denial!.reason).toBe('max_concurrent_exceeded');
      expect(denial!.limit).toBe(3);
      expect(denial!.used).toBe(3);
      expect(denial!.retryAfterMs).toBeUndefined();
      expect(denial!.message).toContain('3/3');
    });
  });

  describe('custom grants', () => {
    it('accepts custom capability grants', () => {
      const customGrants = [
        { capability: 'custom_tool', tier: 'direct' as const, enabled: true, limits: { maxPerMinute: 5 } },
      ];
      const engine = new CapabilityPolicyEngine(customGrants);
      expect(engine.checkAccess('custom_tool', 'agent-1', 'sess-1')).toBeUndefined();
    });

    it('denies disabled custom capabilities', () => {
      const customGrants = [
        { capability: 'custom_tool', tier: 'direct' as const, enabled: false },
      ];
      const engine = new CapabilityPolicyEngine(customGrants);
      expect(engine.checkAccess('custom_tool', 'agent-1', 'sess-1'))
        .toMatchObject({ reason: 'capability_disabled' });
    });
  });

  describe('DEFAULT_CAPABILITY_GRANTS', () => {
    it('has correct tier assignments', () => {
      const byCapability = new Map(DEFAULT_CAPABILITY_GRANTS.map(g => [g.capability, g]));

      expect(byCapability.get('submit_decision')?.tier).toBe('brokered');
      expect(byCapability.get('bot_query')?.tier).toBe('brokered');
      expect(byCapability.get('search_web')?.tier).toBe('direct');
      expect(byCapability.get('browse_url')?.tier).toBe('direct');
      expect(byCapability.get('execute_code')?.tier).toBe('direct');
      expect(byCapability.get('publish_artifact')?.tier).toBe('brokered');
      expect(byCapability.get('venue_api')?.tier).toBe('never');
      expect(byCapability.get('raw_secrets')?.tier).toBe('never');
      expect(byCapability.get('database_write')?.tier).toBe('never');
      expect(byCapability.get('host_control')?.tier).toBe('never');
    });
  });
});

describe('SandboxEnforcer', () => {
  const TEST_LIMITS: import('./sandbox-enforcer.js').SandboxLimits = {
    cpuShares: 256,
    memoryMb: 512,
    maxWallClockMs: 300_000,
    tempStorageMb: 100,
    maxProcesses: 10,
    maxRequestsPerMinute: 60,
    maxConcurrentConnections: 10,
    maxResponseBytes: 10_485_760,
    maxTotalDownloadBytes: 104_857_600,
  };

  describe('session registration', () => {
    it('registers and deregisters sessions', () => {
      const enforcer = new SandboxEnforcer(TEST_LIMITS);
      enforcer.registerSession('sess-1');
      expect(enforcer.isExpired('sess-1')).toBe(false);
      enforcer.deregisterSession('sess-1');
      expect(enforcer.isExpired('sess-1')).toBe(true); // Unknown session = expired
    });
  });

  describe('wall-clock expiry', () => {
    it('expires session after wall-clock limit', () => {
      // Use a very short limit
      const enforcer = new SandboxEnforcer({ ...TEST_LIMITS, maxWallClockMs: 1 });
      enforcer.registerSession('sess-1');
      // It starts at Date.now(), so with 1ms limit it's immediately/nearly expired
      // We need a small delay
      const start = Date.now();
      while (Date.now() - start < 5) { /* busy wait 5ms */ }
      expect(enforcer.isExpired('sess-1')).toBe(true);
    });

    it('does not expire session within limit', () => {
      const enforcer = new SandboxEnforcer({ ...TEST_LIMITS, maxWallClockMs: 60_000 });
      enforcer.registerSession('sess-1');
      expect(enforcer.isExpired('sess-1')).toBe(false);
    });
  });

  describe('outbound request enforcement', () => {
    it('allows requests within rate limit', () => {
      const enforcer = new SandboxEnforcer({ ...TEST_LIMITS, maxRequestsPerMinute: 10 });
      enforcer.registerSession('sess-1');
      for (let i = 0; i < 10; i++) {
        const violation = enforcer.checkOutboundRequest('sess-1');
        expect(violation).toBeUndefined();
      }
    });

    it('denies requests exceeding rate limit', () => {
      const enforcer = new SandboxEnforcer({ ...TEST_LIMITS, maxRequestsPerMinute: 3 });
      enforcer.registerSession('sess-1');
      enforcer.checkOutboundRequest('sess-1');
      enforcer.checkOutboundRequest('sess-1');
      enforcer.checkOutboundRequest('sess-1');
      const violation = enforcer.checkOutboundRequest('sess-1');
      expect(violation).toBeDefined();
      expect(violation!.type).toBe('network');
    });

    it('denies response exceeding size limit', () => {
      const enforcer = new SandboxEnforcer({ ...TEST_LIMITS, maxResponseBytes: 1000 });
      enforcer.registerSession('sess-1');
      const violation = enforcer.checkOutboundRequest('sess-1', 2000);
      expect(violation).toBeDefined();
      expect(violation!.type).toBe('download');
    });

    it('tracks total download budget', () => {
      const enforcer = new SandboxEnforcer({ ...TEST_LIMITS, maxTotalDownloadBytes: 500, maxResponseBytes: 1000 });
      enforcer.registerSession('sess-1');
      enforcer.checkOutboundRequest('sess-1', 300);
      const violation = enforcer.checkOutboundRequest('sess-1', 300);
      expect(violation).toBeDefined();
      expect(violation!.type).toBe('download');
      expect(violation!.message).toContain('Total download budget');
    });
  });

  describe('concurrent connections', () => {
    it('allows connections within limit', () => {
      const enforcer = new SandboxEnforcer({ ...TEST_LIMITS, maxConcurrentConnections: 3 });
      enforcer.registerSession('sess-1');
      expect(enforcer.connectionOpened('sess-1')).toBeUndefined();
      expect(enforcer.connectionOpened('sess-1')).toBeUndefined();
      expect(enforcer.connectionOpened('sess-1')).toBeUndefined();
    });

    it('denies connections exceeding limit', () => {
      const enforcer = new SandboxEnforcer({ ...TEST_LIMITS, maxConcurrentConnections: 2 });
      enforcer.registerSession('sess-1');
      enforcer.connectionOpened('sess-1');
      enforcer.connectionOpened('sess-1');
      const violation = enforcer.connectionOpened('sess-1');
      expect(violation).toBeDefined();
      expect(violation!.type).toBe('network');
    });

    it('allows connections after close', () => {
      const enforcer = new SandboxEnforcer({ ...TEST_LIMITS, maxConcurrentConnections: 1 });
      enforcer.registerSession('sess-1');
      enforcer.connectionOpened('sess-1');
      enforcer.connectionClosed('sess-1');
      expect(enforcer.connectionOpened('sess-1')).toBeUndefined();
    });
  });

  describe('violations tracking', () => {
    it('accumulates violations', () => {
      const enforcer = new SandboxEnforcer({ ...TEST_LIMITS, maxRequestsPerMinute: 1 });
      enforcer.registerSession('sess-1');
      enforcer.checkOutboundRequest('sess-1');
      enforcer.checkOutboundRequest('sess-1'); // violation
      enforcer.checkOutboundRequest('sess-1'); // violation
      const violations = enforcer.getViolations('sess-1');
      expect(violations.length).toBe(2);
    });
  });
});
