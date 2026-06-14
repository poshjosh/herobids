import type { ExecutionActor } from '../execution-actor.js';
import {
  type AgentGrantFallbackState,
  shouldUseAgentGrantFallback,
  startAgentGrantFallbackSession,
  isCurrentAgentGrantFallbackSession,
  setAgentGrantFallbackAllowed,
  canUseAgentGrantFallback,
  type AgentExecutionMode,
  type AgentVenueType,
} from '../agent-intake-fallback.js';
import pino from 'pino';

const logger = pino({ name: 'actor-state-owner' });

/**
 * Centralized owner of per-agent transient session state (pending sessions,
 * actor ownership, grant-fallback eligibility). Extracts the three agent-specific
 * Maps from index.ts into one cohesive module.
 *
 * The shared actorRegistry (which also holds bot actors) is passed by reference.
 */
export class ActorStateOwner {
  private readonly pendingSessions = new Map<string, string>();
  private readonly ownerSessions = new Map<string, string>();
  private readonly grantFallback = new Map<string, AgentGrantFallbackState>();

  constructor(private readonly actorRegistry: Map<string, ExecutionActor>) {}

  // --- Actor queries ---

  getActor(agentId: string): ExecutionActor | undefined {
    return this.actorRegistry.get(agentId);
  }

  // --- Session lifecycle ---

  /**
   * Mark a session as pending startup for the given agent.
   * Initializes grant-fallback state (disabled until actor is registered).
   */
  markSessionPending(agentId: string, sessionId: string): void {
    this.pendingSessions.set(agentId, sessionId);
    this.grantFallback.set(agentId, startAgentGrantFallbackSession(sessionId));
  }

  /** True if sessionId is still the one pending for this agent. */
  isSessionPending(agentId: string, sessionId: string): boolean {
    return this.pendingSessions.get(agentId) === sessionId;
  }

  /** True if the grant-fallback state still belongs to the given session. */
  isCurrentFallbackSession(agentId: string, sessionId: string): boolean {
    return isCurrentAgentGrantFallbackSession(this.grantFallback.get(agentId), sessionId);
  }

  /**
   * Register an actor after successful start. Must only be called while
   * `isSessionPending(agentId, sessionId)` is true.
   */
  registerActor(
    agentId: string,
    sessionId: string,
    actor: ExecutionActor,
    executionMode: AgentExecutionMode | undefined,
    venueType: AgentVenueType | undefined,
  ): void {
    this.actorRegistry.set(agentId, actor);
    this.ownerSessions.set(agentId, sessionId);
    this.grantFallback.set(
      agentId,
      setAgentGrantFallbackAllowed(sessionId, shouldUseAgentGrantFallback(executionMode, venueType)),
    );
    logger.info({ agentId, sessionId }, 'Agent actor registered');
  }

  /**
   * Deregister actor on crash — only if the current registry entry matches the given actor.
   */
  deregisterOnCrash(agentId: string, sessionId: string, actor: ExecutionActor): void {
    if (this.actorRegistry.get(agentId) === actor) {
      this.actorRegistry.delete(agentId);
      this.ownerSessions.delete(agentId);
      logger.warn({ agentId, sessionId }, 'Agent actor deregistered after runtime failure');
    }
    this.clearPending(agentId, sessionId);
    this.clearFallback(agentId, sessionId);
  }

  /** Discard an actor that started but whose session changed before registration completed. */
  discardStartedActor(agentId: string, sessionId: string): void {
    this.clearPending(agentId, sessionId);
  }

  /** Clear pending state only if it belongs to the specified session. */
  clearPending(agentId: string, sessionId: string): void {
    if (this.pendingSessions.get(agentId) === sessionId) {
      this.pendingSessions.delete(agentId);
    }
  }

  /** Clear grant-fallback only if it belongs to the specified session. */
  clearFallback(agentId: string, sessionId: string): void {
    if (isCurrentAgentGrantFallbackSession(this.grantFallback.get(agentId), sessionId)) {
      this.grantFallback.delete(agentId);
    }
  }

  // --- Session stop handling ---

  /**
   * Handle a session stop event. Returns the actor to stop (if any),
   * or undefined if this session does not own the current actor.
   */
  handleSessionStopped(agentId: string, sessionId: string): ExecutionActor | undefined {
    this.clearPending(agentId, sessionId);
    this.clearFallback(agentId, sessionId);

    const ownerSession = this.ownerSessions.get(agentId);
    if (ownerSession && ownerSession !== sessionId) {
      logger.debug(
        { agentId, sessionId, ownerSession },
        'Ignoring stale session stop — actor owned by newer session',
      );
      return undefined;
    }

    const actor = this.actorRegistry.get(agentId);
    if (actor) {
      this.actorRegistry.delete(agentId);
      this.ownerSessions.delete(agentId);
      logger.info({ agentId, sessionId }, 'Agent actor deregistered on session stop');
    }
    return actor;
  }

  // --- Grant fallback queries ---

  canUseGrantFallback(agentId: string): boolean {
    return canUseAgentGrantFallback(this.grantFallback.get(agentId));
  }
}
