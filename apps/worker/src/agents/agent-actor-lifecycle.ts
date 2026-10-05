import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { AgentRepository } from '@herobids/db';
import type { ExternalBackendSubject } from '@herobids/domain/external-backend';
import type { ExternalBackendWriteBoundary } from '../external-backend/write-adapter.js';

/**
 * Worker-side agent-actor lifecycle driver (L2 / E1-H). Translates agent session
 * transitions into `start_agent_actor` / `stop_agent_actor` calls over the
 * Traderton side-effecting boundary.
 *
 * Fire-and-forget contract (D5): every method catches everything and never
 * rejects, so a slow or failing boundary can never block or fail a session
 * transition. Each call uses a fresh idempotency key (the lifecycle tools are
 * naturally idempotent; an agent-scoped key would replay a stale start/stop).
 */
export class AgentActorLifecycle {
  constructor(
    private readonly deps: {
      /** `sideEffectBoundary` in index.ts; undefined when the trading backend is unconfigured. */
      boundary: ExternalBackendWriteBoundary | undefined;
      agentRepo: Pick<AgentRepository, 'getAgent' | 'getCurrentSession'>;
      /** Reuse the function behind `approvalVenueAccountResolver`: ready trading connection → venue account. */
      resolveVenueAccountId: (agentId: string) => Promise<string | null>;
      deadlineMs: number;
      logger: Logger;
    },
  ) {}

  /** Start (or reconcile) the agent's traderton actor after a session activates. */
  async start(agentId: string, reason: string): Promise<void> {
    try {
      if (!this.deps.boundary) {
        this.deps.logger.debug({ agentId, reason }, 'agent-actor lifecycle: boundary not configured, skipping start');
        return;
      }
      const ownerId = await this.ownerIdOf(agentId);
      if (!ownerId) return;
      const venueAccountId = await this.deps.resolveVenueAccountId(agentId);
      if (!venueAccountId) {
        this.deps.logger.debug({ agentId, reason }, 'agent-actor lifecycle: agent not trading-capable, skipping start');
        return;
      }
      await this.invoke(agentId, ownerId, 'start_agent_actor', { venueAccountId }, reason);
    } catch (err) {
      this.deps.logger.warn({ agentId, reason, err }, 'agent-actor lifecycle start failed');
    }
  }

  /**
   * Stop the agent's traderton actor after a session stops/crashes/is cleaned up.
   * Skipped (D7) when a newer non-terminal session is live for the agent, so a
   * late stop for an old session cannot kill the new session's actor.
   */
  async stop(agentId: string, reason: string, stoppedSessionId?: string): Promise<void> {
    try {
      if (!this.deps.boundary) {
        this.deps.logger.debug({ agentId, reason }, 'agent-actor lifecycle: boundary not configured, skipping stop');
        return;
      }
      const ownerId = await this.ownerIdOf(agentId);
      if (!ownerId) return;
      const current = await this.deps.agentRepo.getCurrentSession(agentId);
      if (current && current.id !== stoppedSessionId) {
        this.deps.logger.debug(
          { agentId, reason, stoppedSessionId, currentSessionId: current.id },
          'agent-actor lifecycle: a newer session is live, skipping stop',
        );
        return;
      }
      await this.invoke(agentId, ownerId, 'stop_agent_actor', {}, reason);
    } catch (err) {
      this.deps.logger.warn({ agentId, reason, err }, 'agent-actor lifecycle stop failed');
    }
  }

  private async ownerIdOf(agentId: string): Promise<string | null> {
    const agent = await this.deps.agentRepo.getAgent(agentId);
    const ownerId = agent?.userId;
    if (!ownerId) {
      this.deps.logger.warn({ agentId }, 'agent-actor lifecycle: agent has no owner, skipping');
      return null;
    }
    return ownerId;
  }

  private async invoke(agentId: string, ownerId: string, toolName: string, payload: unknown, reason: string): Promise<void> {
    const subject: ExternalBackendSubject = { ownerId, actor: { type: 'agent', id: agentId } };
    const result = await this.deps.boundary!.invokeAndAwait({
      toolName,
      payload,
      subject,
      idempotencyKey: randomUUID(),
      deadlineMs: this.deps.deadlineMs,
    });
    if (result.kind !== 'success') {
      const errorCode = result.kind === 'failure'
        ? ((result.details as Record<string, unknown> | undefined)?.['errorCode'] ?? result.code)
        : result.kind;
      this.deps.logger.warn({ agentId, toolName, reason, errorCode }, 'agent-actor lifecycle call did not succeed');
    }
  }
}
