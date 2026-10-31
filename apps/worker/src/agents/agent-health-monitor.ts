import { eq, and, lt, inArray, notInArray } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { agentRuntimeSessions } from '@herobids/db';
import { RUNTIME_ERROR_CODES, computeCapacityStartupDeadline, type StartupObservationOutcome } from '@herobids/domain';
import type { AgentSessionManager } from './agent-session-manager.js';
import type { AgentRuntimeLauncher } from './agent-runtime-launcher.js';
import { createLogger } from '../logger.js';

const logger = createLogger('agent-health-monitor');

/** Re-evaluations after a lost expiry claim, so a placement or stop racing the claim is seen in the same sweep. */
const MAX_STARTUP_EVALUATION_ATTEMPTS = 3;

interface LaunchingSessionFacts {
  id: string;
  agentId: string;
  startedAt: Date;
  runtimeRegisteredAt: Date | null;
  firstPlacedAt: Date | null;
}

export interface HealthMonitorConfig {
  /** Interval between health checks (ms). Default: 10000 */
  checkIntervalMs: number;
  /** Heartbeat timeout — mark unhealthy after this (ms). Default: 30000 */
  heartbeatTimeoutMs: number;
  /** Budget from session creation to first heartbeat before a start is failed (ms). Default: 60000 */
  startTimeoutMs: number;
  /**
   * P6: capacity-aware startup. Applies only when enabled AND the runtime observes startup
   * (Nomad). Otherwise the legacy startTimeoutMs budget governs every starting session.
   */
  capacityAwareStart: {
    enabled: boolean;
    capacityWaitTimeoutMs: number;
    placedStartTimeoutMs: number;
  };
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
  startTimeoutMs: 60_000,
  capacityAwareStart: {
    enabled: false,
    capacityWaitTimeoutMs: 600_000,
    placedStartTimeoutMs: 120_000,
  },
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
  private launchingSweepInFlight = false;

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
      const now = Date.now();
      const threshold = new Date(now - this.config.heartbeatTimeoutMs);
      const startThreshold = new Date(now - this.config.startTimeoutMs);

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

      const capacityAware = this.isCapacityAwareStartEnabled();
      const staleStartingSessions = await this.db.select()
        .from(agentRuntimeSessions)
        .where(and(
          // Launching sessions under capacity-aware startup are governed by the deadline sweep below.
          inArray(agentRuntimeSessions.status, capacityAware ? ['starting'] : ['starting', 'launching']),
          lt(agentRuntimeSessions.startedAt, startThreshold),
        ));

      for (const session of staleStartingSessions) {
        logger.warn({ sessionId: session.id, agentId: session.agentId, startedAt: session.startedAt }, 'Stale agent start detected');
        await this.sessionManager.handleStartTimeout(session.id);
      }

      if (capacityAware && this.runtimeLauncher) {
        // Fire-and-forget: a slow scheduler call must not delay heartbeat or stop checks above or below.
        // The launcher is passed explicitly: capacity-aware startup is only enabled when one is wired.
        void this.sweepLaunchingSessions(this.runtimeLauncher);
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

  private isCapacityAwareStartEnabled(): boolean {
    return this.config.capacityAwareStart.enabled && this.runtimeLauncher?.supportsStartupObservation() === true;
  }

  /**
   * Evaluates every launching session once. Non-reentrant so a slow scheduler cannot pile up sweeps.
   * Display lag (M4): a session whose job is missing is only expired on a sweep, so the user-visible
   * stop can trail the real deadline by up to one sweep interval. The lag is bounded by one sweep
   * and is accepted; the deadline itself is still enforced from the persisted facts.
   */
  private async sweepLaunchingSessions(launcher: AgentRuntimeLauncher): Promise<void> {
    if (this.launchingSweepInFlight) return;
    this.launchingSweepInFlight = true;
    try {
      const launching = await this.db.select({ id: agentRuntimeSessions.id })
        .from(agentRuntimeSessions)
        .where(eq(agentRuntimeSessions.status, 'launching'));
      for (const row of launching) {
        await this.evaluateLaunchingSession(row.id, launcher);
      }
    } catch (err) {
      logger.error({ err }, 'Launching session startup sweep failed');
    } finally {
      this.launchingSweepInFlight = false;
    }
  }

  private async evaluateLaunchingSession(sessionId: string, launcher: AgentRuntimeLauncher): Promise<void> {
    try {
      for (let attempt = 0; attempt < MAX_STARTUP_EVALUATION_ATTEMPTS; attempt++) {
        let session = await this.loadLaunchingSession(sessionId);
        if (!session) return;

        let outcome: StartupObservationOutcome = 'not_observed';
        if (session.runtimeRegisteredAt === null || session.firstPlacedAt === null) {
          outcome = await this.observeAndRecordStartup(session, launcher);
          // Re-read so the deadline is computed from what the repository now holds, including a stop that won.
          session = await this.loadLaunchingSession(sessionId);
          if (!session) return;
        }

        const deadline = computeCapacityStartupDeadline(
          session,
          this.config.capacityAwareStart,
          this.config.startTimeoutMs,
          outcome,
        );
        if (Date.now() < deadline.atMs) return;

        const expired = await this.sessionManager.expireStartupDeadline(
          session.agentId,
          session.id,
          {
            status: 'launching',
            runtimeRegisteredAt: session.runtimeRegisteredAt,
            firstPlacedAt: session.firstPlacedAt,
          },
          deadline.reason,
        );
        if (expired) {
          logger.warn({ sessionId, agentId: session.agentId, reason: deadline.reason }, 'Agent startup deadline expired');
          return;
        }
        // The claim lost to a placement, heartbeat, or stop. Loop to re-read and re-evaluate.
      }
    } catch (err) {
      logger.warn({ err, sessionId }, 'Launching session startup evaluation failed; will retry on next sweep');
    }
  }

  private async loadLaunchingSession(sessionId: string): Promise<LaunchingSessionFacts | null> {
    const [row] = await this.db.select({
        id: agentRuntimeSessions.id,
        agentId: agentRuntimeSessions.agentId,
        startedAt: agentRuntimeSessions.startedAt,
        runtimeRegisteredAt: agentRuntimeSessions.runtimeRegisteredAt,
        firstPlacedAt: agentRuntimeSessions.firstPlacedAt,
      })
      .from(agentRuntimeSessions)
      .where(and(
        eq(agentRuntimeSessions.id, sessionId),
        eq(agentRuntimeSessions.status, 'launching'),
      ));
    return row ?? null;
  }

  /**
   * Inspects the scheduler and records registration or the earliest placement. Failures change no
   * facts and never extend a deadline; the caller derives the deadline from the outcome.
   */
  private async observeAndRecordStartup(
    session: LaunchingSessionFacts,
    launcher: AgentRuntimeLauncher,
  ): Promise<StartupObservationOutcome> {
    const observed = await launcher.observeStartup(session.agentId, session.id);
    if (!observed.ok) {
      if (observed.error.code === RUNTIME_ERROR_CODES.NOT_FOUND) {
        return 'not_found';
      }
      logger.warn(
        { sessionId: session.id, agentId: session.agentId, code: observed.error.code },
        'Scheduler startup observation failed; startup deadline unchanged',
      );
      return 'inspect_failed';
    }

    const observation = observed.data;
    if (observation.kind === 'queued') {
      if (session.runtimeRegisteredAt === null) {
        await this.sessionManager.recordRuntimeRegistered(session.id, observation.registeredAt ?? session.startedAt);
      }
    } else {
      // A placed job was necessarily registered. Its placement time is an upper bound for registration.
      if (session.runtimeRegisteredAt === null) {
        await this.sessionManager.recordRuntimeRegistered(session.id, observation.placedAt);
      }
      if (session.firstPlacedAt === null || observation.placedAt < session.firstPlacedAt) {
        await this.sessionManager.recordFirstPlacement(session.id, observation.placedAt, observation.allocationId);
      }
    }
    return 'observed';
  }
}
