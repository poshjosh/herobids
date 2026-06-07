import type { MessageEnvelope, HeartbeatPayload, PauseRequestPayload, StopRequestPayload } from '@herobids/domain';
import { buildRuntimeDescriptor } from '@herobids/db';
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
  /**
   * Called after a session's container is successfully launched.
   * Used to subscribe the agent's inbound Redis stream so that heartbeats
   * published by the runtime (or stub) are actually consumed by this worker.
   * Without this, heartbeats are written to Redis but never read, so the
   * session never transitions from 'starting' → 'running' and the health
   * monitor's startup timeout fires and stops the agent.
   */
  streamSubscribe?: (agentId: string) => Promise<void>;
  /**
   * Called when an agent's status changes (best-effort, non-blocking).
   * Used to publish real-time UI events to the user's event channel.
   */
  onAgentStatusChange?: (agentId: string, userId: string, status: string) => void;
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
    // Pre-register launcher handles for sessions that survived a worker restart so that
    // stop() and health-monitor cleanup can reach those containers even if a stop request
    // arrives before the container sends its first heartbeat to the new worker.
    void this.registerSurvivedSessions().catch((err: unknown) => logger.error({ err }, 'Failed to register survived sessions on startup'));
    void this.reconcileStartingSessions().catch((err: unknown) => logger.error({ err }, 'Failed to reconcile starting sessions'));
    this.reconcileTimer = setInterval(() => {
      void this.reconcileStartingSessions().catch((err: unknown) => logger.error({ err }, 'Failed to reconcile starting sessions'));
    }, this.config.healthCheckIntervalMs);
  }

  /**
   * Pre-register launcher handles for sessions that are already running/launching/unhealthy
   * in the DB but have no in-memory handle on this worker.
   *
   * Called at startup so that stop requests issued before the first post-restart heartbeat
   * do not leave survived containers running outside platform control.
   */
  private async registerSurvivedSessions(): Promise<void> {
    if (this.stopping) return;
    const sessions = await this.agentRepo.getSessionsByStatuses(['running', 'launching', 'unhealthy']);
    for (const session of sessions) {
      if (!this.runtimeLauncher.hasRuntime(session.id)) {
        this.runtimeLauncher.registerRecoveredRuntime(session.agentId, session.id);
      }
    }
  }

  /**
   * Stop the reconciliation loop.
   *
   * ## Ownership contract: containers outlive the worker process.
   *
   * Agent runtime containers are intentionally NOT killed on worker shutdown.
   * They continue running independently and reconnect to the next worker via
   * the heartbeat recovery path in `handleHeartbeat`. This allows the worker
   * to be redeployed, restarted, or crash without interrupting live agents.
   *
   * To explicitly stop a specific agent's container, call `stopSession()`.
   * `AgentRuntimeLauncher.stopAll()` exists only for tests and emergency teardowns.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = undefined;
    }
    // Deliberately NOT calling runtimeLauncher.stopAll() — containers outlive the worker.
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
        // Fetch full agent so the container gets its prompt, skills, and policy.
        const agent = await this.agentRepo.getAgent(session.agentId);
        if (!agent) {
          logger.error({ sessionId: session.id, agentId: session.agentId }, 'Agent not found during session launch — skipping');
          continue;
        }
        const capabilityDescriptor = await this.agentRepo.getRuntimeCapabilityDescriptor(agent.id, agent.skillIds ?? []);
        const runtimeDescriptor = buildRuntimeDescriptor({
          agentId: agent.id,
          goal: agent.prompt,
          executionMode: agent.executionMode,
          toolPolicy: (agent.toolPolicy as Record<string, unknown> | null) ?? {},
          dailyTokenBudget: agent.dailyTokenBudget,
          dailyLossLimit: agent.dailyLossLimit,
          maxBots: agent.maxBots,
          maxSlippageBps: agent.maxSlippageBps,
          capabilityDescriptor,
        });
        const agentConfig: Record<string, unknown> = {
          prompt: agent.prompt,
          skillIds: agent.skillIds,
          ...(agent.executionMode != null && { executionMode: agent.executionMode }),
          ...(agent.dailyTokenBudget != null && { dailyTokenBudget: agent.dailyTokenBudget }),
          ...(agent.dailyLossLimit != null && { dailyLossLimit: agent.dailyLossLimit }),
          ...(agent.maxBots != null && { maxBots: agent.maxBots }),
          ...(agent.maxSlippageBps != null && { maxSlippageBps: agent.maxSlippageBps }),
          runtimeDescriptor,
        };
        await this.runtimeLauncher.launch({
          agentId: session.agentId,
          sessionId: session.id,
          agentConfig,
          runtimeDescriptor,
          toolPolicy: (agent.toolPolicy as Record<string, unknown> | null) ?? {},
        });

        if (this.config.streamSubscribe) {
          await this.config.streamSubscribe(session.agentId);
        }
      } catch (err) {
        logger.error({ err, sessionId: session.id, agentId: session.agentId }, 'Failed to launch starting session');

        this.platformAlerts?.fireAlert(PLATFORM_ALERT_EVENTS.EXECUTION_CRITICAL_FAILURE, {
          agentId: session.agentId,
          sessionId: session.id,
          message: 'Agent session launch failed — the runtime could not be started.',
          detail: err instanceof Error ? err.message : String(err),
        }).catch((alertErr: unknown) => logger.warn({ alertErr }, 'Failed to send critical_execution_failure alert'));
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
    // Notify real-time event stream (best-effort)
    if (this.config.onAgentStatusChange) {
      const agent = await this.agentRepo.getAgent(session.agentId).catch(() => null);
      if (agent) {
        this.config.onAgentStatusChange(session.agentId, agent.userId, 'stopped');
      }
    }
  }

  /** Handle heartbeat from agent runtime */
  async handleHeartbeat(envelope: MessageEnvelope, payload: HeartbeatPayload): Promise<void> {
    const session = await this.agentRepo.getSession(payload.sessionId);
    if (!session) {
      logger.warn({ sessionId: payload.sessionId, agentId: envelope.initiatorId }, 'Heartbeat for unknown session');
      return;
    }


      // Bootstrap recovery covers two cases:
      // 1. Normal startup: session is starting/launching/unhealthy and needs to become running.
      // 2. Worker restart recovery: session is already 'running' in the DB but this worker has
      //    no in-memory handle for it. Because containers outlive the worker (they are NOT
      //    killed on shutdown), a restarted worker will see heartbeats from containers it did
      //    not launch itself. Re-bootstrapping the reconnect handler here re-establishes the
      //    live trading context (bots, positions, market subscriptions) for the recovered runtime.
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
      // Re-register the runtime handle so that stop() and health-monitor cleanup
      // can find this container on the new worker after a restart. Without this,
      // runtimeLauncher.stop(sessionId) is a no-op and the container escapes control.
      this.runtimeLauncher.registerRecoveredRuntime(session.agentId, payload.sessionId);
      // Notify real-time event stream (best-effort)
      if (this.config.onAgentStatusChange) {
        const agent = await this.agentRepo.getAgent(session.agentId).catch(() => null);
        if (agent) {
          this.config.onAgentStatusChange(session.agentId, agent.userId, 'active');
        }
      }
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

    // Only fire a platform safety alert when the pause was guardrail- or system-initiated.
    // Agent self-pauses (requestedBy: 'agent') are normal workflow pauses, not safety events.
    const requestedBy = payload.requestedBy ?? envelope.initiatorType;
    const isGuardrailPause = requestedBy === 'guardrail' || requestedBy === 'system';
    if (isGuardrailPause) {
      this.platformAlerts?.fireAlert(PLATFORM_ALERT_EVENTS.PAUSED_BY_GUARDRAIL, {
        agentId: agent.id,
        message: `Agent paused by guardrail: ${payload.reason ?? 'no reason given'}`,
      }).catch((err: unknown) => logger.warn({ err }, 'Failed to send paused_by_guardrail alert'));
    }
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
      // No active session: notify real-time stream directly (best-effort)
      if (this.config.onAgentStatusChange) {
        this.config.onAgentStatusChange(agent.id, agent.userId, 'stopped');
      }
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
    // Notify real-time event stream (best-effort)
    if (this.config.onAgentStatusChange) {
      const agent = await this.agentRepo.getAgent(session.agentId).catch(() => null);
      if (agent) {
        // Start-timeout persists 'stopped' in the DB; emit the same status so UI is consistent.
        this.config.onAgentStatusChange(session.agentId, agent.userId, 'stopped');
      }
    }

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
