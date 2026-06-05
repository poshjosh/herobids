import pino from 'pino';

const logger = pino({ name: 'capability-policy' });

/**
 * Capability tiers per docs/tech/agents/tool-access-and-sandboxing.md:
 * - brokered: must go through platform mediation (decisions, secrets, DB writes)
 * - direct: allowed from sandbox with budget enforcement (web research, public APIs)
 * - never: never allowed from agent runtime (venue APIs, raw secrets, host control)
 */
export type CapabilityTier = 'brokered' | 'direct' | 'never';

export interface CapabilityGrant {
  /** Capability identifier (e.g. 'web_fetch', 'code_execute', 'decision_submit') */
  capability: string;
  /** Access tier */
  tier: CapabilityTier;
  /** Whether this capability is currently enabled */
  enabled: boolean;
  /** Per-session budget limits */
  limits?: CapabilityLimits;
}

export interface CapabilityLimits {
  /** Max invocations per session */
  maxInvocations?: number;
  /** Max invocations per minute */
  maxPerMinute?: number;
  /** Max concurrent active calls */
  maxConcurrent?: number;
  /** Max wall-clock time per invocation (ms) */
  timeoutMs?: number;
  /** Max response/output size (bytes) */
  maxResponseBytes?: number;
  /** Max total download size per session (bytes) */
  maxTotalDownloadBytes?: number;
}

export interface ToolInvocationRecord {
  capability: string;
  agentId: string;
  sessionId: string;
  timestamp: string;
  durationMs: number;
  inputSummary: string;
  outputSummary: string;
  success: boolean;
  errorCode?: string;
}

/**
 * Default v1 capability policy — conservative defaults.
 * Operator can override per-agent via tool_policy in the agents table.
 */
export const DEFAULT_CAPABILITY_GRANTS: CapabilityGrant[] = [
  {
    capability: 'decision_submit',
    tier: 'brokered',
    enabled: true,
    limits: { maxPerMinute: 10, maxConcurrent: 1, timeoutMs: 30_000 },
  },
  {
    capability: 'web_fetch',
    tier: 'direct',
    enabled: true,
    limits: { maxPerMinute: 30, maxConcurrent: 5, timeoutMs: 30_000, maxResponseBytes: 5 * 1024 * 1024, maxTotalDownloadBytes: 50 * 1024 * 1024 },
  },
  {
    // code_execute runs locally inside the agent container (network-sandboxed by sandbox-exec.sh).
    // It does not go through the broker, so tier is 'direct'.
    capability: 'code_execute',
    tier: 'direct',
    enabled: true,
    limits: { maxPerMinute: 5, maxConcurrent: 1, timeoutMs: 60_000, maxResponseBytes: 1024 * 1024 },
  },
  {
    capability: 'artifact_publish',
    tier: 'brokered',
    enabled: true,
    limits: { maxPerMinute: 20, maxConcurrent: 3, timeoutMs: 10_000 },
  },
  {
    capability: 'send_message',
    tier: 'brokered',
    enabled: true,
    limits: { maxPerMinute: 10, maxConcurrent: 5, timeoutMs: 10_000, maxResponseBytes: 4096 },
  },
  {
    // manage_bot is OFF by default — only enabled for agents with the 'trading' skill preset
    capability: 'manage_bot',
    tier: 'brokered',
    enabled: false,
    limits: { maxPerMinute: 5, maxConcurrent: 1, timeoutMs: 30_000 },
  },
  {
    capability: 'venue_api',
    tier: 'never',
    enabled: false,
  },
  {
    capability: 'raw_secrets',
    tier: 'never',
    enabled: false,
  },
  {
    capability: 'database_write',
    tier: 'never',
    enabled: false,
  },
  {
    capability: 'host_control',
    tier: 'never',
    enabled: false,
  },
];

/**
 * CapabilityPolicyEngine — enforces capability grants at the platform level.
 *
 * All tool invocations pass through this gate. Denied requests fail closed and are logged.
 */
export class CapabilityPolicyEngine {
  private readonly grants: Map<string, CapabilityGrant>;
  private readonly usageCounters = new Map<string, { count: number; windowStart: number }>();
  private readonly concurrencyCounters = new Map<string, number>();
  private readonly auditLog: ToolInvocationRecord[] = [];
  private killed = false;

  constructor(grants?: CapabilityGrant[]) {
    const effectiveGrants = grants ?? DEFAULT_CAPABILITY_GRANTS;
    this.grants = new Map(effectiveGrants.map((g) => [g.capability, g]));
  }

  /**
   * Check whether a capability invocation is allowed.
   * Returns an error string if denied, undefined if allowed.
   */
  checkAccess(capability: string, _agentId: string, sessionId: string): string | undefined {
    // Kill switch
    if (this.killed) {
      return 'kill_switch_active';
    }

    const grant = this.grants.get(capability);
    if (!grant) {
      return 'unknown_capability';
    }

    if (!grant.enabled) {
      return 'capability_disabled';
    }

    if (grant.tier === 'never') {
      return 'capability_never_allowed';
    }

    // Rate limit check
    if (grant.limits?.maxPerMinute) {
      const key = `${sessionId}:${capability}`;
      const now = Date.now();
      const counter = this.usageCounters.get(key);

      if (counter && now - counter.windowStart < 60_000) {
        if (counter.count >= grant.limits.maxPerMinute) {
          return 'rate_limit_exceeded';
        }
      }
    }

    // Concurrency check
    if (grant.limits?.maxConcurrent) {
      const key = `${sessionId}:${capability}`;
      const current = this.concurrencyCounters.get(key) ?? 0;
      if (current >= grant.limits.maxConcurrent) {
        return 'max_concurrent_exceeded';
      }
    }

    return undefined;
  }

  /** Record the start of a capability invocation (increment concurrency) */
  recordStart(capability: string, sessionId: string): void {
    const concKey = `${sessionId}:${capability}`;
    this.concurrencyCounters.set(concKey, (this.concurrencyCounters.get(concKey) ?? 0) + 1);

    // Increment rate counter
    const rateKey = `${sessionId}:${capability}`;
    const now = Date.now();
    const counter = this.usageCounters.get(rateKey);
    if (!counter || now - counter.windowStart >= 60_000) {
      this.usageCounters.set(rateKey, { count: 1, windowStart: now });
    } else {
      counter.count++;
    }
  }

  /** Record the end of a capability invocation */
  recordEnd(capability: string, sessionId: string, record: ToolInvocationRecord): void {
    const concKey = `${sessionId}:${capability}`;
    const current = this.concurrencyCounters.get(concKey) ?? 0;
    this.concurrencyCounters.set(concKey, Math.max(0, current - 1));

    this.auditLog.push(record);
  }

  /** Activate the kill switch — all subsequent invocations are denied */
  activateKillSwitch(): void {
    this.killed = true;
    logger.warn('Capability kill switch activated — all agent tool invocations denied');
  }

  /** Deactivate the kill switch */
  deactivateKillSwitch(): void {
    this.killed = false;
    logger.info('Capability kill switch deactivated');
  }

  /** Get the capability grant for a given capability (for inspection) */
  getGrant(capability: string): CapabilityGrant | undefined {
    return this.grants.get(capability);
  }

  /** Get recent audit records */
  getAuditLog(limit = 100): ToolInvocationRecord[] {
    return this.auditLog.slice(-limit);
  }

  /** Reset session-scoped counters (call on session end) */
  resetSession(sessionId: string): void {
    for (const key of [...this.usageCounters.keys()]) {
      if (key.startsWith(`${sessionId}:`)) {
        this.usageCounters.delete(key);
      }
    }
    for (const key of [...this.concurrencyCounters.keys()]) {
      if (key.startsWith(`${sessionId}:`)) {
        this.concurrencyCounters.delete(key);
      }
    }
  }
}
