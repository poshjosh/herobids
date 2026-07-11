import type {
  MessageEnvelope,
  HeartbeatPayload,
  PauseRequestPayload,
  StopRequestPayload,
  RuntimeBudgetPolicy,
  PlansConfig,
  UsageBillingConfig,
  ProvidersYaml,
} from '@herobids/domain';
import { resolveAgentRuntimePolicy, toGuardrailNumber } from '@herobids/domain';
import { buildRuntimeDescriptor } from '@herobids/db';
import type { AgentRepository, UsageBillingRepository } from '@herobids/db';
import type { InstanceEventPublisher } from './instance-event-publisher.js';
import type { AgentReconnectHandler } from './agent-reconnect-handler.js';
import type { AgentRuntimeLauncher } from './agent-runtime-launcher.js';
import type { PlatformAlertService } from '../alerting/platform-alert-service.js';
import { PLATFORM_ALERT_EVENTS } from '../alerting/platform-alert-service.js';
import { resolveEffectiveLlmSelection } from '../llm-selection.js';
import type { Redis } from 'ioredis';
import { createLogger } from '../logger.js';

const logger = createLogger('agent-session-manager');

/** Per-agent timeout for Redis stream subscription during survived-session recovery. */
const STREAM_SUBSCRIBE_TIMEOUT_MS = 10_000;

export interface AgentSessionManagerConfig {
  /** Heartbeat timeout in ms — mark runtime unhealthy after this. Default: 30000 */
  heartbeatTimeoutMs: number;
  /** Interval in ms to check for stale sessions. Default: 10000 */
  healthCheckIntervalMs: number;
  /** Interval in ms to reconcile Docker containers against the DB. Default: 60000 */
  containerReconcileIntervalMs?: number;
  /** Resolved runtime budget policy from operator config. */
  budgets: RuntimeBudgetPolicy;
  /** Operator-configured agent risk defaults — forwarded to agent containers for contract resolution. */
  agentRiskDefaults?: Record<string, unknown>;
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
  /**
   * Called when an agent session becomes active (first successful heartbeat).
   * Used to create and register the AgentTradingActor in the actorRegistry.
    * Return `false` when the runtime is healthy but no trading actor/fallback was
    * established yet, so activation should be retried on a later heartbeat.
   */
  onSessionActive?: (agentId: string, executionMode: string | null, sessionId: string) => boolean | void | Promise<boolean | void>;
  /**
   * Called once for brand-new sessions after they become active.
   * Used to send an initial user-facing anchor message without duplicating it on recovery.
   */
  onSessionStarted?: (agentId: string, sessionId: string) => void | Promise<void>;
  /**
   * Called when an agent session is stopped.
   * Used to stop and deregister the AgentTradingActor from the actorRegistry.
   */
  onSessionStopped?: (agentId: string, sessionId: string) => void;
  /** Optional usage billing repo — used to check spend state before session launch */
  usageBillingRepo?: UsageBillingRepository;
  /** Optional plan and usage-billing configs — used to apply plan packaging to billing periods */
  plansConfig?: PlansConfig;
  usageBillingConfig?: UsageBillingConfig;
  /** Provider registry — forwarded to agent containers for per-model rate card seeding */
  providersYaml?: ProvidersYaml;
}

/**
 * AgentSessionManager — owns session lifecycle, heartbeats, cleanup, and reconnect policy.
 *
 * Monitors agent runtime health and marks sessions unhealthy when heartbeats stop.
 */
export class AgentSessionManager {
  private reconcileTimer?: ReturnType<typeof setInterval>;
  private containerReconcileTimer?: ReturnType<typeof setInterval>;
  private stopping = false;
  private readonly config: AgentSessionManagerConfig;
  /** Sessions whose trading actor has been bootstrapped on this worker. Prevents
   * conflating "runtime handle registered for stop reachability" with "actor activated". */
  private readonly activatedSessions = new Set<string>();
  /** Resolves once survived-session preregistration completes. Actions that need
   * runtime handle reachability (stop, health checks) await this before proceeding. */
  private readyPromise: Promise<void> = Promise.resolve();

  constructor(
    private readonly agentRepo: AgentRepository,
    private readonly eventPublisher: InstanceEventPublisher,
    private readonly runtimeLauncher: AgentRuntimeLauncher,
    config: Pick<AgentSessionManagerConfig, 'budgets'> & Partial<Omit<AgentSessionManagerConfig, 'budgets'>>,
    private readonly reconnectHandler?: AgentReconnectHandler,
    private readonly platformAlerts?: PlatformAlertService,
    private readonly redis?: Redis,
  ) {
    this.config = {
      heartbeatTimeoutMs: 30_000,
      healthCheckIntervalMs: 10_000,
      ...config,
    };
  }

  /** Start the launch reconciliation loop. */
  start(): void {
    // Pre-register launcher handles for sessions that survived a worker restart so that
    // stop() and health-monitor cleanup can reach those containers even if a stop request
    // arrives before the container sends its first heartbeat to the new worker.
    // Actions that need handle reachability await this.readyPromise before proceeding.
    this.readyPromise = this.registerSurvivedSessions().catch((err: unknown) => {
      logger.error({ err }, 'Failed to register survived sessions on startup');
    });
    void this.reconcileStartingSessions().catch((err: unknown) => logger.error({ err }, 'Failed to reconcile starting sessions'));
    this.reconcileTimer = setInterval(() => {
      void this.reconcileStartingSessions().catch((err: unknown) => logger.error({ err }, 'Failed to reconcile starting sessions'));
    }, this.config.healthCheckIntervalMs);
    // Docker container reconciliation runs on a separate, longer interval.
    // Not called immediately — registerSurvivedSessions() must complete first
    // so survived containers are not mistaken for orphans on startup.
    this.containerReconcileTimer = setInterval(() => {
      void this.runtimeLauncher.reconcile().catch((err: unknown) =>
        logger.error({ err }, 'Docker container reconciliation failed'),
      );
    }, this.config.containerReconcileIntervalMs ?? 60_000);
  }

  /**
   * Pre-register launcher handles for sessions that are already running/launching/unhealthy
   * in the DB but have no in-memory handle on this worker.
   *
   * Also re-subscribes to the Redis inbound stream for each survived agent so that
   * heartbeats published by the still-running container are consumed by this worker.
   * Without the stream subscription, heartbeats accumulate in Redis but are never read,
   * causing the health monitor to falsely mark the agent as unhealthy after deploy.
   *
   * Called at startup so that stop requests issued before the first post-restart heartbeat
   * do not leave survived containers running outside platform control.
   */
  private async registerSurvivedSessions(): Promise<void> {
    if (this.stopping) return;
    const sessions = await this.agentRepo.getSessionsByStatuses(['running', 'launching', 'unhealthy']);

    // Register recovered runtime handles for all survived sessions.
    // This is synchronous and must complete before we accept any stop requests
    // (stopSession awaits this.readyPromise).
    for (const session of sessions) {
      if (!this.runtimeLauncher.hasRuntime(session.id)) {
        this.runtimeLauncher.registerRecoveredRuntime(session.agentId, session.id);
      }
    }

    // Rebuild Redis projection for survived sessions so that the ref counter
    // and active set reflect the true state before any heartbeats can arrive.
    // Without this, handleHeartbeat() re-increments the counter on the first
    // post-restart heartbeat, causing unbounded growth across deploys.
    if (this.redis && sessions.length > 0) {
      try {
        const agentCounts = new Map<string, number>();
        for (const session of sessions) {
          agentCounts.set(session.agentId, (agentCounts.get(session.agentId) ?? 0) + 1);
        }
        const uniqueAgentIds = [...agentCounts.keys()];
        const agentRecords = await Promise.all(
          uniqueAgentIds.map((id) => this.agentRepo.getAgent(id).catch(() => null)),
        );
        const agentMap = new Map<string, (typeof agentRecords)[number]>();
        for (let i = 0; i < uniqueAgentIds.length; i++) {
          const id = uniqueAgentIds[i]!;
          const record = agentRecords[i];
          if (record) agentMap.set(id, record);
        }
        for (const [agentId, count] of agentCounts) {
          await this.redis.set(`agent:sessions:count:${agentId}`, String(count));
          await this.redis.sadd('agent:sessions:active', agentId);
          const agentRecord = agentMap.get(agentId);
          if (agentRecord?.wakePreferences) {
            await this.redis.set(`agent:wake:prefs:${agentId}`, JSON.stringify(agentRecord.wakePreferences));
          }
        }
      } catch (err) {
        logger.warn({ err }, 'Failed to rebuild Redis projection for survived sessions');
      }
    }

    // Re-subscribe to agent Redis inbound streams concurrently so that one
    // slow or hanging subscription (e.g. unresponsive Redis) does not block
    // registration of all remaining survived sessions. Each subscription is
    // wrapped in a timeout as a safety net.
    if (this.config.streamSubscribe) {
      const uniqueAgentIds = [...new Set(sessions.map((s) => s.agentId))];
      let failedCount = 0;
      await Promise.allSettled(
        uniqueAgentIds.map((agentId) => {
          let timeoutId: ReturnType<typeof setTimeout>;
          return Promise.race([
            this.config.streamSubscribe!(agentId).then(() => clearTimeout(timeoutId)),
            new Promise<never>((_, reject) => {
              timeoutId = setTimeout(
                () => reject(new Error(`streamSubscribe timed out after ${STREAM_SUBSCRIBE_TIMEOUT_MS}ms`)),
                STREAM_SUBSCRIBE_TIMEOUT_MS,
              );
            }),
          ]).catch((err: unknown) => {
            failedCount += 1;
            logger.error({ err, agentId }, 'Failed to subscribe to survived agent stream');
          });
        }),
      );
      if (failedCount > 0) {
        logger.warn(
          { failedCount, total: uniqueAgentIds.length },
          'Some survived agent stream subscriptions failed during recovery',
        );
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
    if (this.containerReconcileTimer) {
      clearInterval(this.containerReconcileTimer);
      this.containerReconcileTimer = undefined;
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
        const userPlanIdForEnforcement = this.config.usageBillingRepo
          ? await this.config.usageBillingRepo.getUserPlanId(agent.userId)
          : null;
        const resolvedPlanIdForEnforcement = userPlanIdForEnforcement ?? this.config.plansConfig?.defaultPlanId ?? 'free';
        const planUsageForEnforcement = this.config.plansConfig?.plans[resolvedPlanIdForEnforcement]?.usage;

        // Session-start billing enforcement: block hard-limited or suspended accounts.
        if (this.config.usageBillingRepo) {
          try {
            const billingAccount = await this.config.usageBillingRepo.getAccountByUserId(agent.userId);
            if (billingAccount && (billingAccount.status === 'hard_limited' || billingAccount.status === 'suspended')) {
              const topUpsEnabled = Boolean(this.config.usageBillingConfig?.creditTopUpsEnabled) && (planUsageForEnforcement?.topUpPackIds?.length ?? 0) > 0;
              const code = billingAccount.status === 'suspended'
                ? 'billing.account_suspended'
                : (topUpsEnabled ? 'billing.top_up_required' : 'billing.limit_exceeded');
              const message = billingAccount.status === 'suspended'
                ? 'Account suspended — agent session start blocked'
                : (topUpsEnabled
                  ? 'Usage limit reached — top-up required before agent can start'
                  : 'Usage limit reached — agent session start blocked');

              logger.warn({ agentId: agent.id, userId: agent.userId, billingStatus: billingAccount.status }, 'Session launch blocked by billing spend state');
              await this.agentRepo.updateAgent(agent.id, { status: 'stopped' });
              await this.agentRepo.markSessionStopped(session.id, new Date());
              await this.eventPublisher.emitGuardrailTriggered(agent.id, {
                scope: 'agent_guardrail',
                code,
                message,
                details: {
                  sessionId: session.id,
                  billingStatus: billingAccount.status,
                },
              });
              await this.eventPublisher.emitInstanceStatus(agent.id, {
                status: 'stopped',
                reason: code,
                updatedAt: new Date().toISOString(),
              });
              continue;
            }
          } catch (err) {
            logger.warn({ err }, 'Failed to check billing spend state before session launch — proceeding');
          }
        }

        const capabilityDescriptor = await this.agentRepo.getRuntimeCapabilityDescriptor(agent.id);
        const runtimeDescriptor = buildRuntimeDescriptor({
          agentId: agent.id,
          name: agent.name,
          goal: agent.prompt,
          executionMode: agent.executionMode,
          toolPolicy: (agent.toolPolicy as Record<string, unknown> | null) ?? {},
          dailyLossLimit: agent.dailyLossLimit,
          maxDrawdownPct: agent.maxDrawdownPct != null ? Number(agent.maxDrawdownPct) : null,
          maxBots: agent.maxBots,
          maxOpenPositions: toGuardrailNumber(agent.maxOpenPositions),
          maxPositionSizePct: toGuardrailNumber(agent.maxPositionSizePct),
          stopLossPct: toGuardrailNumber(agent.stopLossPct),
          capital: agent.capital ?? null,
          budgets: this.config.budgets,
          capabilityDescriptor,
        });
        const modelPolicy = (agent.modelPolicy as Record<string, unknown> | null | undefined) ?? null;
        const userModelDefaults = await this.agentRepo.getUserAiModelConfig(agent.userId);
        const userPlanId = userPlanIdForEnforcement;
        const resolvedPlanId = userPlanId ?? this.config.plansConfig?.defaultPlanId ?? 'free';
        const planUsage = this.config.plansConfig?.plans[resolvedPlanId]?.usage;

        if (this.config.usageBillingRepo) {
          const includedCreditMicrousd = (planUsage?.includedCreditCents ?? 0) * 10_000;
          const softCapMicrousd = planUsage?.softCapCents != null ? planUsage.softCapCents * 10_000 : null;
          const hardCapMicrousd = planUsage?.hardCapCents != null ? planUsage.hardCapCents * 10_000 : null;

          const billingAccount = await this.config.usageBillingRepo.getOrCreateBillingAccountForUser(
            agent.userId,
            resolvedPlanId,
            {
              softCapMicrousd,
              hardCapMicrousd,
            },
          );
          const activeRateCard = await this.config.usageBillingRepo.ensureActiveRateCard(this.config.usageBillingConfig?.defaultRateCardName ?? 'default');
          await this.config.usageBillingRepo.getOrCreateOpenPeriod(
            billingAccount.id,
            new Date(),
            resolvedPlanId,
            activeRateCard.id,
            includedCreditMicrousd,
            softCapMicrousd,
            hardCapMicrousd,
          );
        }

        const provider = typeof modelPolicy?.['provider'] === 'string' ? modelPolicy['provider'] : undefined;
        const lightModel = typeof modelPolicy?.['lightModel'] === 'string' ? modelPolicy['lightModel'] : undefined;
        const heavyModel = typeof modelPolicy?.['heavyModel'] === 'string' ? modelPolicy['heavyModel'] : undefined;

        // Validate model selection before launch — fail loudly rather than letting the container crash silently.
        const effectiveSelection = resolveEffectiveLlmSelection({
          agentConfig: { provider, lightModel, heavyModel, userModelDefaults: userModelDefaults ?? null },
        });
        if (!effectiveSelection.provider || !effectiveSelection.lightModel || !effectiveSelection.heavyModel) {
          const code = 'config.model_selection_incomplete';
          const message = 'Agent cannot start — provider, lightModel, and heavyModel must be set in agent config or user AI settings';
          logger.warn(
            { agentId: agent.id, userId: agent.userId, ...effectiveSelection },
            message,
          );
          await this.agentRepo.updateAgent(agent.id, { status: 'stopped' });
          await this.agentRepo.markSessionStopped(session.id, new Date());
          await this.eventPublisher.emitGuardrailTriggered(agent.id, {
            scope: 'agent_guardrail',
            code,
            message,
            details: { sessionId: session.id },
          });
          await this.eventPublisher.emitInstanceStatus(agent.id, {
            status: 'stopped',
            reason: code,
            updatedAt: new Date().toISOString(),
          });
          continue;
        }

        const agentConfig: Record<string, unknown> = {
          name: agent.name,
          userId: agent.userId,
          usageBillingPlanId: resolvedPlanId,
          usageBillingIncludedCreditMicrousd: (planUsage?.includedCreditCents ?? 0) * 10_000,
          usageBillingSoftCapMicrousd: planUsage?.softCapCents != null ? planUsage.softCapCents * 10_000 : null,
          usageBillingHardCapMicrousd: planUsage?.hardCapCents != null ? planUsage.hardCapCents * 10_000 : null,
          ...(this.config.usageBillingConfig?.defaultRateCardItems
            ? { usageBillingRateCardItems: this.config.usageBillingConfig.defaultRateCardItems }
            : {}),
          ...(this.config.usageBillingConfig?.fallbackCacheReadPct !== undefined
            ? { usageBillingFallbackCacheReadPct: this.config.usageBillingConfig.fallbackCacheReadPct }
            : {}),
          ...(this.config.usageBillingConfig?.failedRequestOutputPct !== undefined
            ? { usageBillingFailedRequestOutputPct: this.config.usageBillingConfig.failedRequestOutputPct }
            : {}),
          ...(this.config.providersYaml
            ? { providersYaml: this.config.providersYaml }
            : {}),
          ...(provider ? { provider } : {}),
          ...(lightModel ? { lightModel } : {}),
          ...(heavyModel ? { heavyModel } : {}),
          ...(userModelDefaults ? { userModelDefaults } : {}),
          ...(typeof modelPolicy?.['costPreset'] === 'string'
            ? { costPreset: modelPolicy['costPreset'] }
            : {}),
          ...(typeof modelPolicy?.['dailySpendBudgetUsd'] === 'number'
            ? { dailySpendBudgetUsd: modelPolicy['dailySpendBudgetUsd'] }
            : {}),
          ...(Array.isArray(modelPolicy?.['dexWatchlistSymbols'])
            ? {
              dexWatchlistSymbols: (modelPolicy['dexWatchlistSymbols'] as unknown[])
                .filter((value): value is string => typeof value === 'string')
            }
            : {}),
          prompt: agent.prompt,
          ...(agent.executionMode != null && { executionMode: agent.executionMode }),
          ...(agent.dailyLossLimit != null && { dailyLossLimit: agent.dailyLossLimit }),
          ...(agent.maxBots != null && { maxBots: agent.maxBots }),
          ...(agent.maxSlippageBps != null && { maxSlippageBps: agent.maxSlippageBps }),
          ...(agent.tickIntervalMs != null && { tickIntervalMs: agent.tickIntervalMs }),
          ...(agent.capital != null && { capital: agent.capital }),
          // Risk contract fields — forwarded so the agent container can resolve the contract
          maxOpenPositions: agent.maxOpenPositions ?? null,
          maxPositionSizePct: agent.maxPositionSizePct ?? null,
          stopLossPct: agent.stopLossPct ?? null,
          stopLossCooldownMs: agent.stopLossCooldownMs ?? null,
          agentRiskDefaults: this.config.agentRiskDefaults,
          runtimeDescriptor,
          // 004: Explicit capability / hybrid mode from UnifiedAgentConfig
          capabilityMode: agent.unifiedConfig?.capabilityMode ?? 'intelligence',
          hybridMode: agent.unifiedConfig?.hybridMode
            ?? (agent.unifiedConfig?.capabilityMode === 'hybrid' ? 'mixed' : undefined),
          openPositionEscalationToJudgePolicy: agent.openPositionEscalationToJudgePolicy,
          // Per-agent runtime policy — resolved from style + overrides, sent as env var to container
          resolvedRuntimePolicy: resolveAgentRuntimePolicy(
            agent.style ?? null,
            agent.runtimePolicyOverrides ?? null,
          ),
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

        // Clean up the session and revert agent status so the agent can be retried.
        // Without this, the session stays in 'launching' and the agent in 'starting'
        // indefinitely — the health monitor eventually times it out, but the error
        // is silent and the operator sees an unresponsive agent with no diagnostics.
        await this.agentRepo.markSessionStopped(session.id, new Date()).catch((cleanupErr: unknown) => {
          logger.error({ cleanupErr, sessionId: session.id }, 'Failed to mark session stopped after launch failure');
        });
        await this.agentRepo.updateAgent(session.agentId, { status: 'stopped' }).catch((cleanupErr: unknown) => {
          logger.error({ cleanupErr, agentId: session.agentId }, 'Failed to revert agent status after launch failure');
        });

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
    // Ensure survived-session handles are registered before we attempt to reach the container.
    await this.readyPromise;

    const session = await this.agentRepo.getSession(sessionId);
    if (!session) return;

    await this.runtimeLauncher.stop(sessionId);

    const stopped = await this.agentRepo.markSessionStopped(sessionId, new Date());
    if (!stopped) {
      return;
    }

    this.activatedSessions.delete(sessionId);

    // Clean up Redis projection used by market-monitor recipient lookup (C3).
    // Ref-counted: only remove from active set and delete prefs when all sessions
    // for this agent have stopped (supports multi-session agents).
    if (this.redis) {
      try {
        const count = await this.redis.decr(`agent:sessions:count:${session.agentId}`);
        if (count <= 0) {
          await this.redis.srem('agent:sessions:active', session.agentId);
          await this.redis.del(`agent:wake:prefs:${session.agentId}`);
          await this.redis.del(`agent:sessions:count:${session.agentId}`);
        }
      } catch (err) {
        logger.warn({ err, agentId: session.agentId }, 'Failed to clean up wake preferences from Redis on session stop');
      }
    }

    // Stop and deregister the agent trading actor
    if (this.config.onSessionStopped) {
      this.config.onSessionStopped(session.agentId, session.id);
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

  /**
   * Handle a runtime-initiated session end (the container sent session_ended before dying).
   * Session-aware: verifies the session is still active before acting and preserves the
   * runtime-reported terminal status so graceful stops stay stopped and crashes stay crashed.
   */
  async handleRuntimeSessionEnd(sessionId: string, agentId: string, status: 'stopped' | 'crashed'): Promise<void> {
    const ended = await this.agentRepo.markSessionEnded(sessionId, status, new Date());
    if (!ended) {
      // Session already stopped/superseded — stale farewell from a previous container.
      logger.debug({ sessionId, agentId, status }, 'Ignoring stale session_ended — session already terminated');
      return;
    }

    this.activatedSessions.delete(sessionId);

    // Clean up Redis projection used by market-monitor recipient lookup (C3).
    // Ref-counted: only remove from active set and delete prefs when all sessions
    // for this agent have ended (supports multi-session agents).
    if (this.redis) {
      try {
        const count = await this.redis.decr(`agent:sessions:count:${agentId}`);
        if (count <= 0) {
          await this.redis.srem('agent:sessions:active', agentId);
          await this.redis.del(`agent:wake:prefs:${agentId}`);
          await this.redis.del(`agent:sessions:count:${agentId}`);
        }
      } catch (err) {
        logger.warn({ err, agentId }, 'Failed to clean up wake preferences from Redis on runtime session end');
      }
    }

    // Trigger in-memory actor cleanup (same path as stopSession)
    if (this.config.onSessionStopped) {
      this.config.onSessionStopped(agentId, sessionId);
    }

    // Update agent status
    await this.agentRepo.updateAgent(agentId, { status });
    logger.info({ sessionId, agentId, status }, 'Agent runtime session ended');

    // Notify real-time event stream (best-effort)
    if (this.config.onAgentStatusChange) {
      const agent = await this.agentRepo.getAgent(agentId).catch(() => null);
      if (agent) {
        this.config.onAgentStatusChange(agentId, agent.userId, status);
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
      // 1. Normal startup: session is starting/launching and needs to become running.
      // 2. Worker restart recovery: session is already 'running' in the DB but this worker has
      //    not yet bootstrapped its trading actor. We check `activatedSessions` rather than
      //    `hasRuntime()` because `registerSurvivedSessions()` pre-registers runtime handles
      //    for stop-reachability but that should NOT suppress actor activation on first heartbeat.
      //
      // Unhealthy sessions that recover via heartbeat are NOT re-bootstrapped — the actor
      // is still running in-memory. They only need to be marked running again and get a
      // reconnect snapshot. Re-calling onSessionActive would create a duplicate actor.
      const isFirstBoot = session.status === 'starting' || session.status === 'launching';
      const isUnhealthyRecovery = session.status === 'unhealthy' && this.activatedSessions.has(payload.sessionId);
      const shouldBootstrapRecovery = !isUnhealthyRecovery && (
        isFirstBoot
        || session.status === 'unhealthy'
        || (session.status === 'running' && !this.activatedSessions.has(payload.sessionId))
      );

    // Only accept heartbeats for running/starting/launching sessions.
    if (session.status !== 'running' && session.status !== 'starting' && session.status !== 'launching' && session.status !== 'unhealthy') {
      return;
    }

    const markedRunning = await this.agentRepo.markSessionRunning(payload.sessionId, new Date());
    if (!markedRunning) {
      return;
    }

    if (isFirstBoot) {
      await this.agentRepo.recordSessionStartedSkillUsage(session.agentId, payload.sessionId)
        .catch((err: unknown) => logger.warn({ err, sessionId: payload.sessionId }, 'Failed to persist session_started skill usage events'));
    }

    if (payload.cpuPct !== undefined || payload.memoryBytes !== undefined) {
      await this.agentRepo.updateSession(payload.sessionId, {
        cpuPct: payload.cpuPct,
        memoryBytes: payload.memoryBytes,
      });
    }

    if (shouldBootstrapRecovery) {
      // Re-register the runtime handle so that stop() and health-monitor cleanup
      // can find this container on the new worker after a restart. Without this,
      // runtimeLauncher.stop(sessionId) is a no-op and the container escapes control.
      this.runtimeLauncher.registerRecoveredRuntime(session.agentId, payload.sessionId);
      // Create and register the AgentTradingActor for direct agent trading
      let activationEstablished = true;
      if (this.config.onSessionActive) {
        const agent = await this.agentRepo.getAgent(session.agentId).catch(() => null);
        try {
          activationEstablished = await this.config.onSessionActive(session.agentId, agent?.executionMode ?? null, session.id) !== false;
        } catch (err) {
          await this.handleActivationFailure(session.id, session.agentId, agent?.userId, err);
          return;
        }
      }
      if (activationEstablished) {
        this.activatedSessions.add(payload.sessionId);
        // Maintain Redis projection for market-monitor recipient lookup (C3).
        // Only increment for genuinely new sessions (starting/launching → active).
        // Survived sessions were already rebuilt by registerSurvivedSessions() and
        // must NOT increment here, or the counter grows without bound on each restart.
        if (this.redis && isFirstBoot) {
          const agentRecord = await this.agentRepo.getAgent(session.agentId).catch(() => null);
          if (agentRecord) {
            try {
              // Increment session count for this agent — ref-counted to support multi-session agents.
              // Only add to active set when the first session becomes active.
              const count = await this.redis.incr(`agent:sessions:count:${session.agentId}`);
              if (count === 1) {
                await this.redis.sadd('agent:sessions:active', session.agentId);
              }
              if (agentRecord.wakePreferences) {
                await this.redis.set(`agent:wake:prefs:${session.agentId}`, JSON.stringify(agentRecord.wakePreferences));
              }
            } catch (err) {
              logger.warn({ err, agentId: session.agentId }, 'Failed to write wake preferences to Redis on session active');
            }
          }
        }
      }
      await this.agentRepo.updateAgent(session.agentId, { status: 'active' });
      // Notify real-time event stream (best-effort)
      if (this.config.onAgentStatusChange) {
        const agent = await this.agentRepo.getAgent(session.agentId).catch(() => null);
        if (agent) {
          this.config.onAgentStatusChange(session.agentId, agent.userId, 'active');
        }
      }
      if (isFirstBoot && activationEstablished && this.config.onSessionStarted) {
        Promise.resolve(this.config.onSessionStarted(session.agentId, session.id)).catch((err: unknown) => {
          logger.warn({ err, sessionId: session.id, agentId: session.agentId }, 'Failed to run onSessionStarted callback');
        });
      }
    }

    // First successful connect and unhealthy recovery both send the latest
    // instance status/context via the reconnect handler.
    if ((shouldBootstrapRecovery || isUnhealthyRecovery) && this.reconnectHandler) {
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

    // Session-scoped authorization: only the current runtime session can pause the agent.
    // Defense-in-depth: also checked at broker boundary (processInbound step 3).
    if (envelope.initiatorType === 'agent') {
      const runtimeSessionId = envelope.correlationId;
      const isActive = await this.agentRepo.isActiveSession(agent.id, runtimeSessionId);
      if (!isActive) {
        logger.warn({ agentId: agent.id, sessionId: runtimeSessionId }, 'Pause request rejected — stale runtime session');
        return;
      }
    }

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

    // Session-scoped authorization: only the current runtime session can stop the agent.
    // Defense-in-depth: also checked at broker boundary (processInbound step 3).
    if (envelope.initiatorType === 'agent') {
      const runtimeSessionId = envelope.correlationId;
      const isActive = await this.agentRepo.isActiveSession(agent.id, runtimeSessionId);
      if (!isActive) {
        logger.warn({ agentId: agent.id, sessionId: runtimeSessionId }, 'Stop request rejected — stale runtime session');
        return;
      }
    }

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
    await this.readyPromise;

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

  async handleRuntimeFailure(
    sessionId: string,
    agentId: string,
    userId: string | undefined,
    err: unknown,
  ): Promise<void> {
    await this.handleTradingActorFailure({
      sessionId,
      agentId,
      userId,
      err,
      guardrailCode: 'trading_actor.runtime_failed',
      guardrailMessage: 'Agent trading context failed while running — session stopped',
      instanceReason: 'trading_actor_runtime_failed',
      logMessage: 'Agent trading actor failed while running',
      stopFailureLogMessage: 'Failed to stop runtime after trading actor runtime failure',
      platformMessage: 'Agent trading context failed while running — the runtime was stopped.',
    });
  }

  private async handleActivationFailure(
    sessionId: string,
    agentId: string,
    userId: string | undefined,
    err: unknown,
  ): Promise<void> {
    await this.handleTradingActorFailure({
      sessionId,
      agentId,
      userId,
      err,
      guardrailCode: 'trading_actor.start_failed',
      guardrailMessage: 'Agent trading context failed to initialize — session stopped',
      instanceReason: 'trading_actor_start_failed',
      logMessage: 'Agent trading actor failed to initialize',
      stopFailureLogMessage: 'Failed to stop runtime after trading actor initialization failure',
      platformMessage: 'Agent trading context failed to initialize — the runtime was stopped.',
    });
  }

  private async handleTradingActorFailure(args: {
    sessionId: string;
    agentId: string;
    userId: string | undefined;
    err: unknown;
    guardrailCode: string;
    guardrailMessage: string;
    instanceReason: string;
    logMessage: string;
    stopFailureLogMessage: string;
    platformMessage: string;
  }): Promise<void> {
    const {
      sessionId,
      agentId,
      userId,
      err,
      guardrailCode,
      guardrailMessage,
      instanceReason,
      logMessage,
      stopFailureLogMessage,
      platformMessage,
    } = args;
    const detail = err instanceof Error ? err.message : String(err);
    const session = await this.agentRepo.getSession(sessionId);

    if (!session || session.status === 'stopped' || session.status === 'crashed') {
      logger.info({ sessionId, agentId, status: session?.status }, 'Agent trading actor failure ignored — session already terminal');
      return;
    }

    const activeSession = await this.agentRepo.getActiveSession(agentId);
    if (activeSession && activeSession.id !== sessionId) {
      logger.info(
        { sessionId, agentId, activeSessionId: activeSession.id },
        'Agent trading actor failure ignored — a newer session is already active',
      );
      return;
    }

    logger.error({ err, sessionId, agentId }, logMessage);

    await this.runtimeLauncher.stop(sessionId).catch((stopErr: unknown) => {
      logger.warn({ stopErr, sessionId, agentId }, stopFailureLogMessage);
    });

    await this.agentRepo.updateSession(sessionId, {
      status: 'crashed',
      stoppedAt: new Date(),
    });
    await this.agentRepo.updateAgent(agentId, { status: 'crashed' });

    await this.eventPublisher.emitGuardrailTriggered(agentId, {
      scope: 'agent_guardrail',
      code: guardrailCode,
      message: guardrailMessage,
      details: { sessionId, detail },
    });

    await this.eventPublisher.emitInstanceStatus(agentId, {
      status: 'stopped',
      reason: instanceReason,
      updatedAt: new Date().toISOString(),
    });

    if (this.config.onAgentStatusChange && userId) {
      this.config.onAgentStatusChange(agentId, userId, 'crashed');
    }

    this.platformAlerts?.fireAlert(PLATFORM_ALERT_EVENTS.RUNTIME_FAILED, {
      agentId,
      sessionId,
      message: platformMessage,
      detail,
    }).catch((alertErr: unknown) => logger.warn({ alertErr }, 'Failed to send platform actor-start failure alert'));
  }
}
