import type { MessageEnvelope, HeartbeatPayload, PauseRequestPayload, StopRequestPayload } from '@herobids/domain';
import type { AgentRepository } from '@herobids/db';
import type { InstanceEventPublisher } from './instance-event-publisher.js';
import type { AgentReconnectHandler } from './agent-reconnect-handler.js';
import type { AgentRuntimeLauncher } from './agent-runtime-launcher.js';
import type { PlatformAlertService } from '../alerting/platform-alert-service.js';
import { PLATFORM_ALERT_EVENTS } from '../alerting/platform-alert-service.js';
import pino from 'pino';

const logger = pino({ name: 'agent-session-manager' });

export interface AgentSessionManagerConfig {
  /** Heartbeat timeout in ms — mark runtime unhealthy after this. Default: 30000 */
  heartbeatTimeoutMs: number;
  /** Interval in ms to check for stale sessions. Default: 10000 */
  healthCheckIntervalMs: number;
}

const DEFAULT_CONFIG: AgentSessionManagerConfig = {
  heartbeatTimeoutMs: 30_000,
  healthCheckIntervalMs: 10_000,
};

/**
 * AgentSessionManager — owns session lifecycle, heartbeats, cleanup, and reconnect policy.
 *
 * Monitors agent runtime health and marks sessions unhealthy when heartbeats stop.
 */
export class AgentSessionManager {
  private reconcileTimer?: ReturnType<typeof setInterval>;
  private stopping = false;
  private readonly config: AgentSessionManagerConfig;

  constructor(
    private readonly agentRepo: AgentRepository,
    private readonly eventPublisher: InstanceEventPublisher,
    private readonly runtimeLauncher: AgentRuntimeLauncher,
    config?: Partial<AgentSessionManagerConfig>,
    private readonly reconnectHandler?: AgentReconnectHandler,
    private readonly platformAlerts?: PlatformAlertService,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Start the launch reconciliation loop. */
  start(): void {
    void this.reconcileStartingSessions().catch((err: unknown) => logger.error({ err }, 'Failed to reconcile starting sessions'));
    this.reconcileTimer = setInterval(() => {
      void this.reconcileStartingSessions().catch((err: unknown) => logger.error({ err }, 'Failed to reconcile starting sessions'));
    }, this.config.healthCheckIntervalMs);
  }

  /** Stop the launch loop and any tracked runtimes. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = undefined;
    }

    await this.runtimeLauncher.stopAll();
  }

  /** Start a new agent runtime session */
  async startSession(agentId: string, sessionId?: string): Promise<string> {
    const createdSessionId = await this.agentRepo.createSession({ id: sessionId, agentId });
    logger.info({ agentId, sessionId: createdSessionId }, 'Agent session created');
    return createdSessionId;
  }

  /** Launch any starting sessions that have not yet been connected. */
  async reconcileStartingSessions(): Promise<void> {
    if (this.stopping) return;
    const sessions = await this.agentRepo.getLaunchableStartingSessions();

    for (const session of sessions) {
      if (this.stopping) return;
      if (this.runtimeLauncher.hasRuntime(session.id)) {
        continue;
      }

      // Atomically claim the session (starting → launching) before launching.
      // This prevents duplicate launches when multiple worker processes reconcile concurrently.
      const claimed = await this.agentRepo.claimStartingSession(session.id);
      if (!claimed) {
        continue;
      }

      try {
        await this.runtimeLauncher.launch({
          agentId: session.agentId,
          sessionId: session.id,
        });
      } catch (err) {
        logger.error({ err, sessionId: session.id, agentId: session.agentId }, 'Failed to launch starting session');
      }
    }
  }

  /** Stop an agent session gracefully */
  async stopSession(sessionId: string): Promise<void> {
    const session = await this.agentRepo.getSession(sessionId);
    if (!session) return;

    await this.runtimeLauncher.stop(sessionId);

    const stopped = await this.agentRepo.markSessionStopped(sessionId, new Date());
    if (!stopped) {
      return;
    }

    // Update agent status
    await this.agentRepo.updateAgent(session.agentId, { status: 'stopped' });
    logger.info({ sessionId, agentId: session.agentId }, 'Agent session stopped');
  }

  /** Handle heartbeat from agent runtime */
  async handleHeartbeat(envelope: MessageEnvelope, payload: HeartbeatPayload): Promise<void> {
    const session = await this.agentRepo.getSession(payload.sessionId);
    if (!session) {
      logger.warn({ sessionId: payload.sessionId, agentId: envelope.initiatorId }, 'Heartbeat for unknown session');
      return;
    }


      // Also bootstrap if the session is already 'running' in the DB but the launcher has no
      // in-memory handle — this happens when the worker restarts while a runtime was live.
      const shouldBootstrapRecovery = session.status === 'starting' || session.status === 'launching' || session.status === 'unhealthy'
        || (session.status === 'running' && !this.runtimeLauncher.hasRuntime(payload.sessionId));

    // Only accept heartbeats for running/starting/launching sessions.
    if (session.status !== 'running' && session.status !== 'starting' && session.status !== 'launching' && session.status !== 'unhealthy') {
      return;
    }

    const markedRunning = await this.agentRepo.markSessionRunning(payload.sessionId, new Date());
    if (!markedRunning) {
      return;
    }

    if (payload.cpuPct !== undefined || payload.memoryBytes !== undefined) {
      await this.agentRepo.updateSession(payload.sessionId, {
        cpuPct: payload.cpuPct,
        memoryBytes: payload.memoryBytes,
      });
    }

    if (shouldBootstrapRecovery) {
      await this.agentRepo.updateAgent(session.agentId, { status: 'active' });
    }

    // First successful connect and unhealthy recovery both bootstrap the runtime
    // with the latest instance status/context via the reconnect handler.
    if (shouldBootstrapRecovery && this.reconnectHandler) {
      this.reconnectHandler.handleReconnect(session.agentId, payload.sessionId).catch(
        (err: unknown) => logger.error({ err, sessionId: payload.sessionId }, 'Reconnect recovery failed'),
      );
    }
  }

  /** Handle pause request from agent */
  async handlePauseRequest(envelope: MessageEnvelope, payload: PauseRequestPayload): Promise<void> {
    const agent = await this.agentRepo.getAgent(envelope.initiatorId);
    if (!agent) return;

    // Idempotent: already paused is success
    if (agent.status === 'paused') return;

    await this.agentRepo.updateAgent(agent.id, {
      status: 'paused',
      pauseState: {
        reason: payload.reason,
        requestedBy: payload.requestedBy ?? envelope.initiatorType,
        pausedAt: new Date().toISOString(),
      },
    });

    await this.eventPublisher.emitInstanceStatus(agent.id, {
      status: 'paused',
      reason: payload.reason,
      updatedAt: new Date().toISOString(),
    });

    logger.info({ agentId: agent.id, reason: payload.reason }, 'Agent paused');
  }

  /** Handle stop request from agent */
  async handleStopRequest(envelope: MessageEnvelope, payload: StopRequestPayload): Promise<void> {
    const agent = await this.agentRepo.getAgent(envelope.initiatorId);
    if (!agent) return;

    // Idempotent: already stopped is success
    if (agent.status === 'stopped') return;

    // Use instance-scoped lookup so a stale runtime from an old link cannot
    // stop the session belonging to the current (relinked) instance.
    const session = await this.agentRepo.getActiveSession(agent.id);
    if (session) {
      await this.stopSession(session.id);
    } else {
      await this.agentRepo.updateAgent(agent.id, { status: 'stopped' });
    }

    logger.info({ agentId: agent.id, reason: payload.reason }, 'Agent stop requested');
  }

  /** Mark a never-connected session as stopped after launch timeout. */
  async handleStartTimeout(sessionId: string): Promise<void> {
    const session = await this.agentRepo.getSession(sessionId);
    if (!session || (session.status !== 'starting' && session.status !== 'launching')) {
      return;
    }

    const timedOut = await this.agentRepo.markSessionStartTimedOut(sessionId, new Date());
    if (!timedOut) {
      return;
    }

    await this.runtimeLauncher.stop(sessionId);
    await this.agentRepo.updateAgent(session.agentId, { status: 'stopped' });
    logger.warn({ sessionId, agentId: session.agentId }, 'Agent session start timed out');

    this.platformAlerts?.fireAlert(PLATFORM_ALERT_EVENTS.RUNTIME_FAILED, {
      agentId: session.agentId,
      sessionId,
      message: 'Agent runtime failed to start — the runtime did not connect within the expected window.',
    }).catch((err: unknown) => logger.warn({ err }, 'Failed to send platform start-timeout alert'));
  }

  /** Mark a session as unhealthy (called by health monitor) */
  async markUnhealthy(sessionId: string): Promise<void> {
    const session = await this.agentRepo.getSession(sessionId);
    if (!session || session.status !== 'running') return;

    await this.agentRepo.updateSession(sessionId, { status: 'unhealthy' });

    // Emit guardrail triggered
    await this.eventPublisher.emitGuardrailTriggered(session.agentId, {
      scope: 'agent_guardrail',
      code: 'heartbeat.timeout',
      message: 'Agent runtime heartbeat lost — new decisions will not be trusted',
    });

    logger.warn({ sessionId, agentId: session.agentId }, 'Agent session marked unhealthy — heartbeat lost');

    this.platformAlerts?.fireAlert(PLATFORM_ALERT_EVENTS.RUNTIME_UNHEALTHY, {
      agentId: session.agentId,
      sessionId,
      message: 'Agent runtime heartbeat lost. New decisions will not be accepted until the runtime reconnects.',
    }).catch((err: unknown) => logger.warn({ err }, 'Failed to send platform unhealthy alert'));
  }
}
