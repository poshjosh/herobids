import { eq, and, lt, inArray, notInArray } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { agentRuntimeSessions } from '@herobids/db';
import type { AgentSessionManager } from './agent-session-manager.js';
import type { AgentRuntimeLauncher } from './agent-runtime-launcher.js';
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
    private readonly runtimeLauncher?: AgentRuntimeLauncher,
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

      // Clean up in-memory runtime handles for sessions that are now stopped/crashed in DB.
      // This handles the case where the API stop endpoint marks a session stopped but the
      // launcher's in-memory map still has a handle (e.g. between health check cycles).
      if (this.runtimeLauncher) {
        const activeHandles = this.runtimeLauncher.getActiveRuntimes();
        if (activeHandles.length > 0) {
          const handleSessionIds = activeHandles.map((h) => h.sessionId);
          const stoppedSessions = await this.db.select({ id: agentRuntimeSessions.id })
            .from(agentRuntimeSessions)
            .where(and(
              inArray(agentRuntimeSessions.id, handleSessionIds),
              notInArray(agentRuntimeSessions.status, ['starting', 'launching', 'running', 'unhealthy']),
            ));
          for (const session of stoppedSessions) {
            logger.info({ sessionId: session.id }, 'Cleaning up runtime handle for stopped session');
            // Call stop() so that if the container is still running (e.g. Docker
            // daemon hasn't reported the die event yet, or the in-memory handle
            // was already dropped), it gets killed now. stop() handles the case
            // where the in-memory handle is already missing by looking up the
            // container by agent ID via the DB.
            await this.runtimeLauncher.stop(session.id);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Health check failed');
    }
  }
}
