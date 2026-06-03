import pino from 'pino';

const logger = pino({ name: 'sandbox-enforcer' });

/**
 * Sandbox resource limits — configurable per agent session.
 * Per ADR 003: one container per agent runtime, code execution inside that container.
 */
export interface SandboxLimits {
  /** Max CPU shares (relative weight) */
  cpuShares: number;
  /** Max memory in MB */
  memoryMb: number;
  /** Max wall-clock time per session (ms). 0 = unlimited. */
  maxWallClockMs: number;
  /** Max temporary storage in MB */
  tempStorageMb: number;
  /** Max concurrent processes */
  maxProcesses: number;
  /** Max outbound requests per minute */
  maxRequestsPerMinute: number;
  /** Max concurrent outbound connections */
  maxConcurrentConnections: number;
  /** Max single response size (bytes) */
  maxResponseBytes: number;
  /** Max total download size per session (bytes) */
  maxTotalDownloadBytes: number;
}

/** Conservative v1 defaults */
export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  cpuShares: 256,
  memoryMb: 512,
  maxWallClockMs: 300_000, // 5 minutes per session
  tempStorageMb: 100,
  maxProcesses: 10,
  maxRequestsPerMinute: 60,
  maxConcurrentConnections: 10,
  maxResponseBytes: 10 * 1024 * 1024, // 10MB
  maxTotalDownloadBytes: 100 * 1024 * 1024, // 100MB
};

export interface SandboxViolation {
  type: 'memory' | 'cpu' | 'time' | 'storage' | 'processes' | 'network' | 'download';
  message: string;
  value: number;
  limit: number;
  timestamp: string;
}

/**
 * SandboxEnforcer — monitors and enforces resource limits for agent runtimes.
 *
 * In v1, this tracks limits in-process. In production, limits are also enforced
 * by the container runtime (Docker cgroups/ulimits).
 */
export class SandboxEnforcer {
  private readonly sessions = new Map<string, SessionState>();
  private readonly limits: SandboxLimits;

  constructor(limits?: Partial<SandboxLimits>) {
    this.limits = { ...DEFAULT_SANDBOX_LIMITS, ...limits };
  }

  /** Register a new session for enforcement */
  registerSession(sessionId: string): void {
    this.sessions.set(sessionId, {
      startedAt: Date.now(),
      requestCount: 0,
      requestWindowStart: Date.now(),
      activeConnections: 0,
      totalDownloadBytes: 0,
      violations: [],
    });
  }

  /** Deregister a session (cleanup) */
  deregisterSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Check if a session has exceeded its wall-clock limit */
  isExpired(sessionId: string): boolean {
    const state = this.sessions.get(sessionId);
    if (!state) return true;
    if (this.limits.maxWallClockMs === 0) return false;
    return Date.now() - state.startedAt > this.limits.maxWallClockMs;
  }

  /** Check and record an outbound request */
  checkOutboundRequest(sessionId: string, responseSize?: number): SandboxViolation | undefined {
    const state = this.sessions.get(sessionId);
    if (!state) return { type: 'network', message: 'Unknown session', value: 0, limit: 0, timestamp: new Date().toISOString() };

    // Rate limit
    const now = Date.now();
    if (now - state.requestWindowStart >= 60_000) {
      state.requestCount = 0;
      state.requestWindowStart = now;
    }
    state.requestCount++;

    if (state.requestCount > this.limits.maxRequestsPerMinute) {
      const violation: SandboxViolation = {
        type: 'network',
        message: 'Request rate limit exceeded',
        value: state.requestCount,
        limit: this.limits.maxRequestsPerMinute,
        timestamp: new Date().toISOString(),
      };
      state.violations.push(violation);
      return violation;
    }

    // Response size
    if (responseSize && responseSize > this.limits.maxResponseBytes) {
      const violation: SandboxViolation = {
        type: 'download',
        message: 'Response size exceeded',
        value: responseSize,
        limit: this.limits.maxResponseBytes,
        timestamp: new Date().toISOString(),
      };
      state.violations.push(violation);
      return violation;
    }

    // Total download budget
    if (responseSize) {
      state.totalDownloadBytes += responseSize;
      if (state.totalDownloadBytes > this.limits.maxTotalDownloadBytes) {
        const violation: SandboxViolation = {
          type: 'download',
          message: 'Total download budget exceeded',
          value: state.totalDownloadBytes,
          limit: this.limits.maxTotalDownloadBytes,
          timestamp: new Date().toISOString(),
        };
        state.violations.push(violation);
        return violation;
      }
    }

    return undefined;
  }

  /** Increment active connections */
  connectionOpened(sessionId: string): SandboxViolation | undefined {
    const state = this.sessions.get(sessionId);
    if (!state) return undefined;

    state.activeConnections++;
    if (state.activeConnections > this.limits.maxConcurrentConnections) {
      const violation: SandboxViolation = {
        type: 'network',
        message: 'Max concurrent connections exceeded',
        value: state.activeConnections,
        limit: this.limits.maxConcurrentConnections,
        timestamp: new Date().toISOString(),
      };
      state.violations.push(violation);
      return violation;
    }
    return undefined;
  }

  /** Decrement active connections */
  connectionClosed(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.activeConnections = Math.max(0, state.activeConnections - 1);
  }

  /** Get violations for a session */
  getViolations(sessionId: string): SandboxViolation[] {
    return this.sessions.get(sessionId)?.violations ?? [];
  }

  /** Get current limits (for inspection) */
  getLimits(): Readonly<SandboxLimits> {
    return this.limits;
  }
}

interface SessionState {
  startedAt: number;
  requestCount: number;
  requestWindowStart: number;
  activeConnections: number;
  totalDownloadBytes: number;
  violations: SandboxViolation[];
}
