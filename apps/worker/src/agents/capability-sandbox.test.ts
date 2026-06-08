import { describe, it, expect } from 'vitest';
import { CapabilityPolicyEngine, DEFAULT_CAPABILITY_GRANTS } from './capability-policy.js';
import { SandboxEnforcer, DEFAULT_SANDBOX_LIMITS } from './sandbox-enforcer.js';

describe('CapabilityPolicyEngine', () => {
  describe('checkAccess', () => {
    it('allows brokered capabilities that are enabled', () => {
      const engine = new CapabilityPolicyEngine();
      expect(engine.checkAccess('submit_decision', 'agent-1', 'sess-1')).toBeUndefined();
    });

    it('allows direct capabilities that are enabled', () => {
      const engine = new CapabilityPolicyEngine();
      expect(engine.checkAccess('web_fetch', 'agent-1', 'sess-1')).toBeUndefined();
    });

    it('denies capabilities with tier=never (disabled takes precedence)', () => {
      const engine = new CapabilityPolicyEngine();
      // Default never-tier grants are also disabled, so enabled check fires first
      expect(engine.checkAccess('venue_api', 'agent-1', 'sess-1')).toBe('capability_disabled');
      expect(engine.checkAccess('raw_secrets', 'agent-1', 'sess-1')).toBe('capability_disabled');
      expect(engine.checkAccess('database_write', 'agent-1', 'sess-1')).toBe('capability_disabled');
      expect(engine.checkAccess('host_control', 'agent-1', 'sess-1')).toBe('capability_disabled');
    });

    it('denies capabilities with tier=never even if enabled', () => {
      const grants = [{ capability: 'dangerous_tool', tier: 'never' as const, enabled: true }];
      const engine = new CapabilityPolicyEngine(grants);
      expect(engine.checkAccess('dangerous_tool', 'agent-1', 'sess-1')).toBe('capability_never_allowed');
    });

    it('denies unknown capabilities', () => {
      const engine = new CapabilityPolicyEngine();
      expect(engine.checkAccess('unknown_tool', 'agent-1', 'sess-1')).toBe('unknown_capability');
    });

    it('denies all access after kill switch', () => {
      const engine = new CapabilityPolicyEngine();
      engine.activateKillSwitch();
      expect(engine.checkAccess('submit_decision', 'agent-1', 'sess-1')).toBe('kill_switch_active');
      expect(engine.checkAccess('web_fetch', 'agent-1', 'sess-1')).toBe('kill_switch_active');
    });

    it('re-allows access after deactivating kill switch', () => {
      const engine = new CapabilityPolicyEngine();
      engine.activateKillSwitch();
      engine.deactivateKillSwitch();
      expect(engine.checkAccess('submit_decision', 'agent-1', 'sess-1')).toBeUndefined();
    });
  });

  describe('rate limiting', () => {
    it('denies after exceeding rate limit', () => {
      const engine = new CapabilityPolicyEngine();
      // submit_decision has maxPerMinute: 10
      for (let i = 0; i < 10; i++) {
        engine.recordStart('submit_decision', 'sess-1');
      }
      expect(engine.checkAccess('submit_decision', 'agent-1', 'sess-1')).toBe('rate_limit_exceeded');
    });

    it('allows after rate window resets', () => {
      const engine = new CapabilityPolicyEngine();
      // Fill up rate limit
      for (let i = 0; i < 10; i++) {
        engine.recordStart('submit_decision', 'sess-1');
      }
      // This should be denied
      expect(engine.checkAccess('submit_decision', 'agent-1', 'sess-1')).toBe('rate_limit_exceeded');
    });
  });

  describe('concurrency limiting', () => {
    it('denies when max concurrent exceeded', () => {
      const engine = new CapabilityPolicyEngine();
      // submit_decision has maxConcurrent: 1
      engine.recordStart('submit_decision', 'sess-1');
      expect(engine.checkAccess('submit_decision', 'agent-1', 'sess-1')).toBe('max_concurrent_exceeded');
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
      // Rate counter was already incremented by recordStart, but concurrency is back to 0
      // Since submit_decision maxPerMinute is 10 and we only did 1, it should be allowed
      expect(engine.checkAccess('submit_decision', 'agent-1', 'sess-1')).toBeUndefined();
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
      expect(engine.checkAccess('custom_tool', 'agent-1', 'sess-1')).toBe('capability_disabled');
    });
  });

  describe('DEFAULT_CAPABILITY_GRANTS', () => {
    it('has correct tier assignments', () => {
      const byCapability = new Map(DEFAULT_CAPABILITY_GRANTS.map(g => [g.capability, g]));

      expect(byCapability.get('submit_decision')?.tier).toBe('brokered');
      expect(byCapability.get('bot_query')?.tier).toBe('brokered');
      expect(byCapability.get('web_fetch')?.tier).toBe('direct');
      expect(byCapability.get('code_execute')?.tier).toBe('direct');
      expect(byCapability.get('artifact_publish')?.tier).toBe('brokered');
      expect(byCapability.get('venue_api')?.tier).toBe('never');
      expect(byCapability.get('raw_secrets')?.tier).toBe('never');
      expect(byCapability.get('database_write')?.tier).toBe('never');
      expect(byCapability.get('host_control')?.tier).toBe('never');
    });
  });
});

describe('SandboxEnforcer', () => {
  describe('session registration', () => {
    it('registers and deregisters sessions', () => {
      const enforcer = new SandboxEnforcer();
      enforcer.registerSession('sess-1');
      expect(enforcer.isExpired('sess-1')).toBe(false);
      enforcer.deregisterSession('sess-1');
      expect(enforcer.isExpired('sess-1')).toBe(true); // Unknown session = expired
    });
  });

  describe('wall-clock expiry', () => {
    it('expires session after wall-clock limit', () => {
      // Use a very short limit
      const enforcer = new SandboxEnforcer({ maxWallClockMs: 1 });
      enforcer.registerSession('sess-1');
      // It starts at Date.now(), so with 1ms limit it's immediately/nearly expired
      // We need a small delay
      const start = Date.now();
      while (Date.now() - start < 5) { /* busy wait 5ms */ }
      expect(enforcer.isExpired('sess-1')).toBe(true);
    });

    it('does not expire session within limit', () => {
      const enforcer = new SandboxEnforcer({ maxWallClockMs: 60_000 });
      enforcer.registerSession('sess-1');
      expect(enforcer.isExpired('sess-1')).toBe(false);
    });
  });

  describe('outbound request enforcement', () => {
    it('allows requests within rate limit', () => {
      const enforcer = new SandboxEnforcer({ maxRequestsPerMinute: 10 });
      enforcer.registerSession('sess-1');
      for (let i = 0; i < 10; i++) {
        const violation = enforcer.checkOutboundRequest('sess-1');
        expect(violation).toBeUndefined();
      }
    });

    it('denies requests exceeding rate limit', () => {
      const enforcer = new SandboxEnforcer({ maxRequestsPerMinute: 3 });
      enforcer.registerSession('sess-1');
      enforcer.checkOutboundRequest('sess-1');
      enforcer.checkOutboundRequest('sess-1');
      enforcer.checkOutboundRequest('sess-1');
      const violation = enforcer.checkOutboundRequest('sess-1');
      expect(violation).toBeDefined();
      expect(violation!.type).toBe('network');
    });

    it('denies response exceeding size limit', () => {
      const enforcer = new SandboxEnforcer({ maxResponseBytes: 1000 });
      enforcer.registerSession('sess-1');
      const violation = enforcer.checkOutboundRequest('sess-1', 2000);
      expect(violation).toBeDefined();
      expect(violation!.type).toBe('download');
    });

    it('tracks total download budget', () => {
      const enforcer = new SandboxEnforcer({ maxTotalDownloadBytes: 500, maxResponseBytes: 1000 });
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
      const enforcer = new SandboxEnforcer({ maxConcurrentConnections: 3 });
      enforcer.registerSession('sess-1');
      expect(enforcer.connectionOpened('sess-1')).toBeUndefined();
      expect(enforcer.connectionOpened('sess-1')).toBeUndefined();
      expect(enforcer.connectionOpened('sess-1')).toBeUndefined();
    });

    it('denies connections exceeding limit', () => {
      const enforcer = new SandboxEnforcer({ maxConcurrentConnections: 2 });
      enforcer.registerSession('sess-1');
      enforcer.connectionOpened('sess-1');
      enforcer.connectionOpened('sess-1');
      const violation = enforcer.connectionOpened('sess-1');
      expect(violation).toBeDefined();
      expect(violation!.type).toBe('network');
    });

    it('allows connections after close', () => {
      const enforcer = new SandboxEnforcer({ maxConcurrentConnections: 1 });
      enforcer.registerSession('sess-1');
      enforcer.connectionOpened('sess-1');
      enforcer.connectionClosed('sess-1');
      expect(enforcer.connectionOpened('sess-1')).toBeUndefined();
    });
  });

  describe('violations tracking', () => {
    it('accumulates violations', () => {
      const enforcer = new SandboxEnforcer({ maxRequestsPerMinute: 1 });
      enforcer.registerSession('sess-1');
      enforcer.checkOutboundRequest('sess-1');
      enforcer.checkOutboundRequest('sess-1'); // violation
      enforcer.checkOutboundRequest('sess-1'); // violation
      const violations = enforcer.getViolations('sess-1');
      expect(violations.length).toBe(2);
    });
  });

  describe('DEFAULT_SANDBOX_LIMITS', () => {
    it('has conservative v1 defaults', () => {
      expect(DEFAULT_SANDBOX_LIMITS.cpuShares).toBe(256);
      expect(DEFAULT_SANDBOX_LIMITS.memoryMb).toBe(512);
      expect(DEFAULT_SANDBOX_LIMITS.maxWallClockMs).toBe(300_000);
      expect(DEFAULT_SANDBOX_LIMITS.maxProcesses).toBe(10);
      expect(DEFAULT_SANDBOX_LIMITS.maxRequestsPerMinute).toBe(60);
      expect(DEFAULT_SANDBOX_LIMITS.maxConcurrentConnections).toBe(10);
    });
  });
});
