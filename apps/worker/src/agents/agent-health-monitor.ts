import { eq, and, lt, inArray } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { agentRuntimeSessions } from '@herobids/db';
import type { AgentSessionManager } from './agent-session-manager.js';
import pino from 'pino';

const logger = pino({ name: 'agent-health-monitor' });

export interface HealthMonitorConfig {
  /** Interval between health checks (ms). Default: 10000 */
  checkIntervalMs: number;
  /** Heartbeat timeout — mark unhealthy after this (ms). Default: 30000 */
  heartbeatTimeoutMs: number;
}

const DEFAULT_CONFIG: HealthMonitorConfig = {
  checkIntervalMs: 10_000,
  heartbeatTimeoutMs: 30_000,
};

/**
 * AgentHealthMonitor — periodically scans for stale agent sessions and marks them unhealthy.
 *
 * Per the recovery contract: heartbeat timeout marks the runtime unhealthy
 * and stops trusting new agent input. Already-accepted decisions continue.
 */
export class AgentHealthMonitor {
  private timer?: ReturnType<typeof setInterval>;
  private readonly config: HealthMonitorConfig;

  constructor(
    private readonly db: Database,
    private readonly sessionManager: AgentSessionManager,
    config?: Partial<HealthMonitorConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  start(): void {
    this.timer = setInterval(() => this.checkHealth(), this.config.checkIntervalMs);
    logger.info({ intervalMs: this.config.checkIntervalMs }, 'Agent health monitor started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async checkHealth(): Promise<void> {
    try {
      const threshold = new Date(Date.now() - this.config.heartbeatTimeoutMs);

      // Find running sessions with stale heartbeats
      const staleRunningSessions = await this.db.select()
        .from(agentRuntimeSessions)
        .where(and(
          eq(agentRuntimeSessions.status, 'running'),
          lt(agentRuntimeSessions.lastHeartbeatAt, threshold),
        ));

      for (const session of staleRunningSessions) {
        logger.warn({ sessionId: session.id, agentId: session.agentId, lastHeartbeat: session.lastHeartbeatAt }, 'Stale agent session detected');
        await this.sessionManager.markUnhealthy(session.id);
      }

      const staleStartingSessions = await this.db.select()
        .from(agentRuntimeSessions)
        .where(and(
          inArray(agentRuntimeSessions.status, ['starting', 'launching']),
          lt(agentRuntimeSessions.startedAt, threshold),
        ));

      for (const session of staleStartingSessions) {
        logger.warn({ sessionId: session.id, agentId: session.agentId, startedAt: session.startedAt }, 'Stale agent start detected');
        await this.sessionManager.handleStartTimeout(session.id);
      }
    } catch (err) {
      logger.error({ err }, 'Health check failed');
    }
  }
}
