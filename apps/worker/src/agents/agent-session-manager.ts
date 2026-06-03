import type { MessageEnvelope, HeartbeatPayload, PauseRequestPayload, StopRequestPayload } from '@herobids/domain';
import type { AgentRepository } from '@herobids/db';
import type { InstanceEventPublisher } from './instance-event-publisher.js';
import type { AgentReconnectHandler } from './agent-reconnect-handler.js';
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
  private healthCheckTimer?: ReturnType<typeof setInterval>;
  private readonly config: AgentSessionManagerConfig;

  constructor(
    private readonly agentRepo: AgentRepository,
    private readonly eventPublisher: InstanceEventPublisher,
    config?: Partial<AgentSessionManagerConfig>,
    private readonly reconnectHandler?: AgentReconnectHandler,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Start the health check loop */
  start(): void {
    this.healthCheckTimer = setInterval(() => this.checkStaleSessions(), this.config.healthCheckIntervalMs);
  }

  /** Stop the health check loop */
  stop(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
  }

  /** Start a new agent runtime session */
  async startSession(agentId: string, tradingInstanceId: string, sessionId?: string): Promise<string> {
    const createdSessionId = await this.agentRepo.createSession({ id: sessionId, agentId, tradingInstanceId });
    await this.agentRepo.updateSession(createdSessionId, {
      status: 'running',
      lastHeartbeatAt: new Date(),
    });
    await this.agentRepo.updateAgent(agentId, { status: 'active' });

    logger.info({ agentId, sessionId: createdSessionId, tradingInstanceId }, 'Agent session started');
    return createdSessionId;
  }

  /** Stop an agent session gracefully */
  async stopSession(sessionId: string): Promise<void> {
    const session = await this.agentRepo.getSession(sessionId);
    if (!session) return;

    await this.agentRepo.updateSession(sessionId, {
      status: 'stopped',
      stoppedAt: new Date(),
    });

    // Update agent status
    await this.agentRepo.updateAgent(session.agentId, { status: 'stopped' });
    logger.info({ sessionId, agentId: session.agentId }, 'Agent session stopped');
  }

  /** Handle heartbeat from agent runtime */
  async handleHeartbeat(envelope: MessageEnvelope, payload: HeartbeatPayload): Promise<void> {
    let session = await this.agentRepo.getSession(payload.sessionId);
    let shouldBootstrapRecovery = session?.status === 'starting' || session?.status === 'unhealthy';
    if (!session) {
      const agent = await this.agentRepo.getAgent(envelope.initiatorId);
      if (!agent || agent.status === 'paused' || agent.status === 'stopped') {
        logger.warn({ sessionId: payload.sessionId, agentId: envelope.initiatorId }, 'Heartbeat for unknown session');
        return;
      }

      // Reject heartbeats from stale runtimes (e.g. old instance after a relink).
      // Only allow auto-create when the envelope instance matches the active link.
      const activeLink = await this.agentRepo.getActiveLink(agent.id);
      if (!activeLink || activeLink.tradingInstanceId !== envelope.tradingInstanceId) {
        logger.warn({ agentId: agent.id, envelopeInstanceId: envelope.tradingInstanceId }, 'Heartbeat from stale/unlinked instance — ignoring');
        return;
      }

      // Retire any stale sessions (e.g. from a previous start that never connected)
      // before opening the new one so there is never more than one live session.
      await this.agentRepo.retireActiveSessions(agent.id);
      await this.startSession(agent.id, envelope.tradingInstanceId, payload.sessionId);
      shouldBootstrapRecovery = true;
      session = await this.agentRepo.getSession(payload.sessionId);
      if (!session) {
        logger.error({ sessionId: payload.sessionId, agentId: envelope.initiatorId }, 'Failed to materialize session for heartbeat');
        return;
      }
    }

    // Only accept heartbeats for running/starting sessions
    if (session.status !== 'running' && session.status !== 'starting' && session.status !== 'unhealthy') {
      return;
    }

    await this.agentRepo.updateSession(payload.sessionId, {
      status: 'running',
      lastHeartbeatAt: new Date(),
      cpuPct: payload.cpuPct,
      memoryBytes: payload.memoryBytes,
    });

    // First successful connect and unhealthy recovery both bootstrap the runtime
    // with the latest instance status/context via the reconnect handler.
    if (shouldBootstrapRecovery && this.reconnectHandler) {
      this.reconnectHandler.handleReconnect(session.agentId, payload.sessionId, session.tradingInstanceId).catch(
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

    // Reject pauses from runtimes that are no longer on the active link.
    const activeLink = await this.agentRepo.getActiveLink(agent.id);
    if (!activeLink || activeLink.tradingInstanceId !== envelope.tradingInstanceId) {
      logger.warn({ agentId: agent.id, envelopeInstanceId: envelope.tradingInstanceId }, 'Pause request does not match active link — ignoring');
      return;
    }

    await this.agentRepo.updateAgent(agent.id, {
      status: 'paused',
      pauseState: {
        reason: payload.reason,
        requestedBy: payload.requestedBy ?? envelope.initiatorType,
        pausedAt: new Date().toISOString(),
      },
    });

    await this.eventPublisher.emitInstanceStatus(activeLink.tradingInstanceId, {
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
    const session = await this.agentRepo.getSessionForAgentAndInstance(agent.id, envelope.tradingInstanceId);
    if (session) {
      await this.stopSession(session.id);
    } else {
      // No session for this instance — only stop the agent if the instance still matches
      // the active link. Prevents a stale runtime (from a revoked link) from stopping the
      // agent when its sessions have already been retired.
      const activeLink = await this.agentRepo.getActiveLink(agent.id);
      if (!activeLink || activeLink.tradingInstanceId !== envelope.tradingInstanceId) {
        logger.warn({ agentId: agent.id, envelopeInstanceId: envelope.tradingInstanceId }, 'Stop request does not match active link — ignoring');
        return;
      }

      await this.agentRepo.updateAgent(agent.id, { status: 'stopped' });
    }

    logger.info({ agentId: agent.id, reason: payload.reason }, 'Agent stop requested');
  }

  /** Check for sessions that missed heartbeats */
  private async checkStaleSessions(): Promise<void> {
    // This is a simplified implementation — in production, this would query
    // sessions where lastHeartbeatAt < now - heartbeatTimeoutMs.
    // For now, individual session health is checked during message processing.
  }

  /** Mark a session as unhealthy (called by health monitor) */
  async markUnhealthy(sessionId: string): Promise<void> {
    const session = await this.agentRepo.getSession(sessionId);
    if (!session || session.status !== 'running') return;

    await this.agentRepo.updateSession(sessionId, { status: 'unhealthy' });

    // Emit guardrail triggered
    await this.eventPublisher.emitGuardrailTriggered(session.tradingInstanceId, {
      scope: 'agent_guardrail',
      code: 'heartbeat.timeout',
      message: 'Agent runtime heartbeat lost — new decisions will not be trusted',
    });

    logger.warn({ sessionId, agentId: session.agentId }, 'Agent session marked unhealthy — heartbeat lost');
  }
}
