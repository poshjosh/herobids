import { eq, and, desc, sql } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { agentConnections, connections } from '@herobids/db';
import type { AgentRepository, PositionRepository, DecisionRepository, ExecutionPlanRepository, FillRepository, OrderRepository, BalanceSnapshotRepository, BacktestingRepository } from '@herobids/db';
import type { AgentRiskDefaultsConfig, AgentRiskOverrides, MarkSource, SwapTokenSafetyPort } from '@herobids/domain';
import { quantity, price } from '@herobids/domain';
import { PaperExecutor, realClock, flatPosition } from '@herobids/engine';
import type { DecisionContext, PositionState } from '@herobids/engine';
import type { IdGenerator } from '@herobids/engine';
import type { Journal } from '@herobids/engine';
import type { TradingCyclePersistence } from '@herobids/engine';
import pino from 'pino';
import { buildAgentRiskLimits } from '../agent-risk-limits.js';
import type { VenueInstrumentCache } from '../venue-instrument-cache.js';
import type { IntakeResult } from '../execution-actor.js';
import { resolveSwapNetwork } from '../resolve-swap-assets.js';

const logger = pino({ name: 'agent-intake-resolver' });

export interface AgentIntakeResolverDeps {
  db: Database;
  agentRepo: AgentRepository;
  positionRepo: PositionRepository;
  decisionRepo: DecisionRepository;
  planRepo: ExecutionPlanRepository;
  fillRepo: FillRepository;
  orderRepo: OrderRepository;
  balanceSnapshotRepo: BalanceSnapshotRepository;
  backtestingRepo: BacktestingRepository;
  journal: Journal;
  markSource: MarkSource;
  idGen: IdGenerator & { planId(): string };
  agentRiskDefaults: AgentRiskDefaultsConfig;
  swapTokenSafety?: SwapTokenSafetyPort;
  oneInchConfig?: { tokenSafetyNetwork?: string; chainId?: number };
  instrumentCache?: VenueInstrumentCache;
}

/**
 * Resolves DecisionIntakeDeps for agent actors via active agent connections.
 *
 * This enables agents to trade directly without first creating a bot.
 * Currently supports paper execution mode only.
 */
export class AgentIntakeResolver {
  constructor(private readonly deps: AgentIntakeResolverDeps) {}

  async getIntakeDeps(agentId: string, instrumentId: string): Promise<IntakeResult> {
    const binding = await this.resolveActiveBinding(agentId);
    if (!binding) return undefined;
    const agent = await this.deps.agentRepo.getAgent(agentId);

    // Fail closed: grant fallback must only serve paper-mode agents.
    // Shadow/live agents depend on the running actor for venue wiring and execution safety.
    // If the agent row is missing, we cannot determine execution mode — fail closed.
    if (!agent) {
      logger.warn({ agentId }, 'Grant fallback rejected — agent row not found, cannot verify execution mode');
      return undefined;
    }
    if (agent.executionMode && agent.executionMode !== 'paper') {
      logger.warn({ agentId, mode: agent.executionMode }, 'Grant fallback rejected — agent is not in paper mode');
      return undefined;
    }

    // Venue symbol validation — reject unknown instruments
    if (this.deps.instrumentCache?.isReady() && !this.deps.instrumentCache.hasSymbol(binding.venue, instrumentId)) {
      return {
        rejected: true,
        code: 'instrument_unknown',
        message: `'${instrumentId}' is not a recognized instrument on ${binding.venue}`,
        retryable: false,
      };
    }

    const openPositions = await this.deps.positionRepo.getOpenByActorAndVenueAccount('agent', agentId, binding.venueAccountId);
    const capitalStr = agent?.capital ?? null;

    const executor = new PaperExecutor(this.deps.idGen);

    // Load persisted runtime risk overrides
    const overrides: AgentRiskOverrides = (agent.riskOverrides as AgentRiskOverrides) ?? {};

    // Resolve swap-specific fields when the binding targets a swap venue.
    // Paper-mode agents without a running actor still need token safety
    // wired so the decision intake pipeline applies the swap safety gate.
    const venueType: 'orderbook' | 'swap' | undefined =
      binding.venue === 'jupiter' || binding.venue === '1inch' ? 'swap' : 'orderbook';
    const swapNetwork = venueType === 'swap'
      ? resolveSwapNetwork(binding.venue, binding, this.deps.oneInchConfig)
      : undefined;
    const swapBaseTokenAddress = instrumentId.includes('/')
      ? instrumentId.split('/')[0]?.split(':').at(-1)
      : instrumentId;

    return {
      actorType: 'agent',
      actorId: agentId,
      venue: binding.venue,
      symbol: instrumentId,
      instrumentId,
      venueAccountId: binding.venueAccountId,
      venueType,
      swapNetwork,
      swapBaseTokenAddress,
      swapTokenSafety: venueType === 'swap' ? this.deps.swapTokenSafety : undefined,
      executor,
      journal: this.deps.journal,
      riskLimits: buildAgentRiskLimits({
        capital: capitalStr,
        dailyLossLimit: agent.dailyLossLimit ?? null,
        maxDrawdownPct: agent.maxDrawdownPct ?? null,
        maxOpenPositions: agent.maxOpenPositions ?? null,
        maxPositionSizePct: agent.maxPositionSizePct ?? null,
        stopLossPct: agent.stopLossPct ?? null,
        stopLossCooldownMs: agent.stopLossCooldownMs ?? null,
      }, this.deps.agentRiskDefaults, overrides),
      markSource: this.deps.markSource,
      persistence: this.buildPersistence(agentId, binding.venueAccountId, binding.venue),
      idGen: { planId: () => this.deps.idGen.planId() },
      clock: realClock,
      openPositionCount: openPositions.filter((position) => position.side !== 'flat').length,
      ...(capitalStr != null ? { equity: price(capitalStr) } : {}),
    };
  }

  async getDecisionContext(agentId: string, instrumentId: string, venue?: string): Promise<DecisionContext | undefined> {
    const markResult = await this.deps.markSource.fetchMark(instrumentId);
    if (!markResult.ok) {
      logger.warn({ agentId, instrumentId, error: markResult.error }, 'Failed to fetch mark for agent context');
      return undefined;
    }

    const position = await this.getPosition(agentId, instrumentId, venue);

    return {
      snapshot: {
        symbol: instrumentId,
        price: markResult.data.price.toString(),
        timestamp: markResult.data.timestamp,
      },
      position: position && position.side !== 'flat' ? {
        side: position.side,
        size: position.size.toString(),
        entryPrice: position.entryPrice.toString(),
        realizedPnl: position.realizedPnl.toString(),
      } : null,
      referenceMark: {
        price: markResult.data.price.toString(),
        source: markResult.data.source,
      },
      strategyParams: {},
    };
  }

  async getPosition(agentId: string, instrumentId: string, venue?: string): Promise<PositionState> {
    const binding = await this.resolveActiveBinding(agentId);
    const positions = binding
      ? await this.deps.positionRepo.getOpenByActorAndVenueAccount('agent', agentId, binding.venueAccountId)
      : await this.deps.positionRepo.getOpenByActor('agent', agentId);
    const match = positions.find((p) => p.symbol === instrumentId);
    if (!match) return flatPosition(venue ?? 'paper', instrumentId);
    return {
      venue: match.venue,
      symbol: match.symbol,
      side: match.side as 'long' | 'short' | 'flat',
      size: quantity(match.size),
      entryPrice: price(match.entryPrice),
      realizedPnl: price(match.realizedPnl ?? '0'),
    };
  }

  /** Resolve the active trading connection for an agent (public for AgentTradingActor setup). */
  async resolveBinding(agentId: string): Promise<{ id: string; venue: string; venueAccountId: string; profile?: Record<string, unknown> | null } | undefined> {
    return this.resolveActiveBinding(agentId);
  }

  private async resolveActiveBinding(agentId: string): Promise<{ id: string; venue: string; venueAccountId: string; profile?: Record<string, unknown> | null } | undefined> {
    const rows = await this.deps.db
      .select({
        connectionId: connections.id,
        provider: connections.provider,
        profile: connections.profile,
        providerRef: connections.providerRef,
        resolvedVenueAccountId: connections.resolvedVenueAccountId,
      })
      .from(agentConnections)
      .innerJoin(connections, eq(agentConnections.connectionId, connections.id))
      .innerJoin(sql`providers`, sql`connections.provider = providers.id`)
      .where(
        and(
          eq(agentConnections.agentId, agentId),
          eq(agentConnections.status, 'active'),
          eq(connections.status, 'active'),
          sql`providers.capabilities ? 'trading'`,
        ),
      )
      .orderBy(desc(agentConnections.grantedAt))
      .limit(1);

    const row = rows[0];
    if (!row) {
      logger.debug({ agentId }, 'No active trading grant found for agent');
      return undefined;
    }

    if (!row.resolvedVenueAccountId) {
      logger.warn({ agentId, connectionId: row.connectionId }, 'Connection has no resolved venue account');
      return undefined;
    }

    return { id: row.connectionId, venue: row.provider, venueAccountId: row.resolvedVenueAccountId, profile: row.profile };
  }

  private buildPersistence(agentId: string, venueAccountId: string, venue: string): TradingCyclePersistence {
    return {
      persistDecision: async (decision) => {
        await this.deps.decisionRepo.insertDecision({
          id: decision.id,
          venueAccountId: decision.venueAccountId,
          instrumentId: decision.instrumentId,
          intent: decision.intent,
          targetSize: decision.targetSize.toString(),
          limitPrice: decision.limitPrice?.toString(),
          contextHash: decision.contextHash,
          actorType: decision.actorType,
          actorId: decision.actorId,
          metadata: decision.metadata,
        });
      },
      persistDecisionContext: async (context) => {
        const latestBalanceSnapshot = await this.deps.balanceSnapshotRepo.getLatestByVenueAccount(
          venueAccountId,
          venue,
        );
        await this.deps.backtestingRepo.insertDecisionContext({
          decisionId: context.decisionId,
          venueAccountId,
          contextHash: context.contextHash,
          context: {
            snapshot: context.snapshot,
            position: context.position,
            referenceMark: context.referenceMark,
            balanceSnapshot: latestBalanceSnapshot
              ? { balances: latestBalanceSnapshot.balances }
              : null,
            strategyParams: context.strategyParams,
          },
        });
      },
      persistPlan: async (plan) => {
        await this.deps.planRepo.insertPlan(plan);
      },
      markPlanExecuting: async (planId) => {
        await this.deps.planRepo.markExecuting(planId);
      },
      markPlanCompleted: async (planId) => {
        await this.deps.planRepo.markCompleted(planId);
      },
      markPlanFailed: async (planId) => {
        await this.deps.planRepo.markFailed(planId);
      },
      persistFill: async (fill) => {
        await this.deps.fillRepo.insertFill({ ...fill, venueAccountId: fill.venueAccountId ?? venueAccountId });
      },
      persistPosition: async (pos) => {
        await this.deps.positionRepo.upsert({
          ...pos,
          actorType: pos.actorType ?? 'agent',
          actorId: pos.actorId ?? agentId,
        });
      },
      persistOrder: async (order) => {
        if (order.venueRefId) {
          await this.deps.orderRepo.upsertByVenueRefId({ ...order, venueRefId: order.venueRefId });
        }
      },
    };
  }
}
