import { eq, and, lt, inArray, notInArray } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { agentRuntimeSessions } from '@herobids/db';
import type { AgentSessionManager } from './agent-session-manager.js';
import type { AgentRuntimeLauncher } from './agent-runtime-launcher.js';
import { createLogger } from '../logger.js';

const logger = createLogger('agent-health-monitor');

export interface HealthMonitorConfig {
  /** Interval between health checks (ms). Default: 10000 */
  checkIntervalMs: number;
  /** Heartbeat timeout — mark unhealthy after this (ms). Default: 30000 */
  heartbeatTimeoutMs: number;
  /**
   * Called when the health monitor finds a terminal session in DB that still has
   * an in-memory runtime handle. This is the controlling path for user-initiated
   * agent stops (the API stop endpoint flips DB state; the health monitor then
   * notices and cleans up the runtime). Fires before runtimeLauncher.stop().
   */
  onTerminalSessionCleanup?: (
    agentId: string,
    sessionId: string,
    status: 'stopped' | 'crashed',
  ) => Promise<void>;
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
          const stoppedSessions = await this.db.select({
              id: agentRuntimeSessions.id,
              agentId: agentRuntimeSessions.agentId,
              status: agentRuntimeSessions.status,
            })
            .from(agentRuntimeSessions)
            .where(and(
              inArray(agentRuntimeSessions.id, handleSessionIds),
              notInArray(agentRuntimeSessions.status, ['starting', 'launching', 'running', 'unhealthy']),
            ));
          for (const session of stoppedSessions) {
            logger.info({ sessionId: session.id }, 'Cleaning up runtime handle for stopped session');
            // Run the cascade callback before stopping the runtime so that
            // agent-created bots are stopped while the agent is still being
            // torn down. This is the controlling path for user-initiated stops
            // because the API stop endpoint only flips DB state.
            try {
              await this.config.onTerminalSessionCleanup?.(
                session.agentId,
                session.id,
                session.status as 'stopped' | 'crashed',
              );
            } catch (err) {
              logger.error({ err, sessionId: session.id, agentId: session.agentId }, 'Terminal session cleanup callback failed');
            }

            // Reset materialized documents to staged so they can be
            // re-materialized when the agent restarts. Best-effort.
            await this.runtimeLauncher.cleanupSessionDocuments(session.agentId, session.id);

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
