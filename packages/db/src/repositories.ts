import crypto from 'node:crypto';
import { eq, and, isNull, desc, or, gte, inArray, notInArray } from 'drizzle-orm';
import type { Database } from './index.js';
import { fills, positions, bots, tradingBindings, executionPlans, orders, balanceSnapshots, decisions, venueAccounts } from './schema/index.js';

export interface InsertFill {
  orderId: string;
  venueAccountId: string;
  /** Convenience alias — stored as actorId for bot actors */
  botId?: string;
  actorType?: string;
  actorId?: string;
  venueRefId?: string;
  venue: string;
  symbol: string;
  side: string;
  quantity: string;
  price: string;
  fee?: string;
  feeCurrency?: string;
  filledAt: Date;
}

export interface UpsertPosition {
  venueAccountId: string;
  actorType: string;
  actorId: string;
  venue: string;
  symbol: string;
  side: string;
  size: string;
  entryPrice: string;
  realizedPnl: string;
  markSource?: string;
}

/**
 * Repository for fill and position persistence.
 */
export class FillRepository {
  constructor(private readonly db: Database) {}

  async insertFill(fill: InsertFill): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.insert(fills).values({
      id,
      orderId: fill.orderId,
      venueAccountId: fill.venueAccountId,
      actorType: fill.actorType ?? 'system',
      actorId: fill.actorId ?? fill.botId ?? null,
      venueRefId: fill.venueRefId ?? null,
      venue: fill.venue,
      symbol: fill.symbol,
      side: fill.side,
      quantity: fill.quantity,
      price: fill.price,
      fee: fill.fee ?? null,
      feeCurrency: fill.feeCurrency ?? null,
      filledAt: fill.filledAt,
    });
    return id;
  }

  /** Get recent fills for an actor, optionally since a timestamp */
  async getRecentByActor(actorType: string, actorId: string, since?: Date, limit?: number) {
    const conditions = [
      eq(fills.actorType, actorType),
      eq(fills.actorId, actorId),
    ];
    if (since) {
      conditions.push(gte(fills.filledAt, since));
    }
    const query = this.db
      .select()
      .from(fills)
      .where(and(...conditions))
      .orderBy(desc(fills.filledAt));
    if (limit) {
      return query.limit(limit);
    }
    return query;
  }

  /** Get recent fills for a trading instance (bot actor) */
  async getRecentByInstance(botId: string, since?: Date, limit?: number) {
    return this.getRecentByActor('bot', botId, since, limit);
  }

  /** Get recent fills for a venue account (all actors). Used by reconciliation. */
  async getRecentByVenueAccount(venueAccountId: string, since?: Date) {
    const conditions = [eq(fills.venueAccountId, venueAccountId)];
    if (since) {
      conditions.push(gte(fills.filledAt, since));
    }
    return this.db
      .select()
      .from(fills)
      .where(and(...conditions))
      .orderBy(desc(fills.filledAt));
  }

  async getLatestFillByInstrument(instrument: string, actorId?: string): Promise<{ price: string; filledAt: string } | null> {
    const conditions = [eq(fills.symbol, instrument)];
    if (actorId) {
      conditions.push(eq(fills.actorId, actorId));
    }
    const rows = await this.db
      .select({ price: fills.price, filledAt: fills.filledAt })
      .from(fills)
      .where(and(...conditions))
      .orderBy(desc(fills.filledAt))
      .limit(1);
    if (!rows[0]) return null;
    return { price: rows[0].price!, filledAt: rows[0].filledAt.toISOString() };
  }
}

export class PositionRepository {
  constructor(private readonly db: Database) {}

  /** Upsert the current position for an actor + symbol */
  async upsert(pos: UpsertPosition): Promise<void> {
    // Find existing open position for this actor+symbol
    const existing = await this.db
      .select()
      .from(positions)
      .where(
        and(
          eq(positions.actorType, pos.actorType),
          eq(positions.actorId, pos.actorId),
          eq(positions.symbol, pos.symbol),
          isNull(positions.closedAt),
        ),
      )
      .limit(1);

    if (pos.side === 'flat') {
      // Close existing position
      if (existing.length > 0) {
        await this.db
          .update(positions)
          .set({
            side: 'flat',
            size: '0',
            realizedPnl: pos.realizedPnl,
            closedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(positions.id, existing[0]!.id));
      }
      return;
    }

    if (existing.length > 0) {
      // Update existing
      await this.db
        .update(positions)
        .set({
          side: pos.side,
          size: pos.size,
          entryPrice: pos.entryPrice,
          realizedPnl: pos.realizedPnl,
          markSource: pos.markSource ?? null,
          updatedAt: new Date(),
        })
        .where(eq(positions.id, existing[0]!.id));
    } else {
      // Insert new
      await this.db.insert(positions).values({
        id: crypto.randomUUID(),
        venueAccountId: pos.venueAccountId,
        actorType: pos.actorType,
        actorId: pos.actorId,
        venue: pos.venue,
        symbol: pos.symbol,
        side: pos.side,
        size: pos.size,
        entryPrice: pos.entryPrice,
        realizedPnl: pos.realizedPnl,
        markSource: pos.markSource ?? null,
        openedAt: new Date(),
      });
    }
  }

  /** Get open positions for an actor */
  async getOpenByActor(actorType: string, actorId: string) {
    return this.db
      .select()
      .from(positions)
      .where(
        and(
          eq(positions.actorType, actorType),
          eq(positions.actorId, actorId),
          isNull(positions.closedAt),
        ),
      );
  }

  /** Get open positions for a trading instance (bot actor) */
  async getOpenByInstance(botId: string) {
    return this.getOpenByActor('bot', botId);
  }

  /** Get all positions for an actor (including closed) */
  async getAllByActor(actorType: string, actorId: string) {
    return this.db
      .select()
      .from(positions)
      .where(
        and(
          eq(positions.actorType, actorType),
          eq(positions.actorId, actorId),
        ),
      )
      .orderBy(desc(positions.updatedAt));
  }

  /** Get open positions for a venue account + symbol across ALL actors.
   *  Used by the risk gate to calculate total exposure. */
  async getOpenByVenueAndSymbol(venueAccountId: string, symbol: string) {
    return this.db
      .select()
      .from(positions)
      .where(
        and(
          eq(positions.venueAccountId, venueAccountId),
          eq(positions.symbol, symbol),
          isNull(positions.closedAt),
        ),
      );
  }
}

export interface InsertExecutionPlan {
  id: string;
  decisionId: string;
  venueAccountId: string;
  actorType?: string;
  actorId?: string;
  venue: string;
  symbol: string;
  action: string;
  plannedOrders: unknown[];
}

export interface UpsertOrder {
  id?: string;
  venueAccountId: string;
  actorType?: string;
  actorId?: string;
  executionPlanId?: string;
  venueRefId: string;
  clientOrderId?: string;
  venue: string;
  symbol: string;
  side: string;
  type: string;
  quantity: string;
  price?: string;
  status: string;
  filledQuantity?: string;
  avgFillPrice?: string;
}

/**
 * Repository for execution plan write-ahead persistence.
 * Plans are persisted BEFORE execution begins (write-ahead) and marked
 * completed/failed after execution resolves.
 */
export class ExecutionPlanRepository {
  constructor(private readonly db: Database) {}

  /** Persist an execution plan before execution starts (write-ahead) */
  async insertPlan(plan: InsertExecutionPlan): Promise<void> {
    await this.db.insert(executionPlans).values({
      id: plan.id,
      decisionId: plan.decisionId,
      venueAccountId: plan.venueAccountId,
      actorType: plan.actorType ?? 'system',
      actorId: plan.actorId ?? null,
      venue: plan.venue,
      symbol: plan.symbol,
      action: plan.action,
      plannedOrders: plan.plannedOrders,
      status: 'pending',
    });
  }

  /** Mark a plan as executing (orders submitted) */
  async markExecuting(planId: string): Promise<void> {
    await this.db
      .update(executionPlans)
      .set({ status: 'executing' })
      .where(eq(executionPlans.id, planId));
  }

  /** Mark a plan as completed */
  async markCompleted(planId: string): Promise<void> {
    await this.db
      .update(executionPlans)
      .set({ status: 'completed', completedAt: new Date() })
      .where(eq(executionPlans.id, planId));
  }

  /** Mark a plan as failed */
  async markFailed(planId: string): Promise<void> {
    await this.db
      .update(executionPlans)
      .set({ status: 'failed', completedAt: new Date() })
      .where(eq(executionPlans.id, planId));
  }

  /** Find incomplete plans for an actor (pending or executing — not terminal) */
  async getIncomplete(actorType: string, actorId: string) {
    return this.db
      .select()
      .from(executionPlans)
      .where(
        and(
          eq(executionPlans.actorType, actorType),
          eq(executionPlans.actorId, actorId),
          or(
            eq(executionPlans.status, 'pending'),
            eq(executionPlans.status, 'executing'),
          ),
        ),
      )
      .orderBy(desc(executionPlans.createdAt));
  }
}

/** Terminal order statuses — orders that can no longer change */
const TERMINAL_ORDER_STATUSES = ['filled', 'cancelled', 'rejected'];

/**
 * Repository for order queries (read-only for reconciliation).
 */
export class OrderRepository {
  constructor(private readonly db: Database) {}

  /** Get open (non-terminal) orders for an actor */
  async getOpenByActor(actorType: string, actorId: string) {
    return this.db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.actorType, actorType),
          eq(orders.actorId, actorId),
          notInArray(orders.status, TERMINAL_ORDER_STATUSES),
        ),
      )
      .orderBy(desc(orders.createdAt));
  }

  /** Get open orders for a trading instance (bot actor) */
  async getOpenByInstance(botId: string) {
    return this.getOpenByActor('bot', botId);
  }

  /** Get all orders belonging to a specific execution plan */
  async getByExecutionPlanId(executionPlanId: string) {
    return this.db
      .select()
      .from(orders)
      .where(eq(orders.executionPlanId, executionPlanId))
      .orderBy(desc(orders.createdAt));
  }

  /** Upsert an order by venueRefId (for private stream updates) — atomic via transaction */
  async upsertByVenueRefId(order: UpsertOrder): Promise<void> {
    await this.db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(orders)
        .where(eq(orders.venueRefId, order.venueRefId))
        .limit(1);

      if (existing.length > 0) {
        await tx
          .update(orders)
          .set({
            status: order.status,
            filledQuantity: order.filledQuantity,
            avgFillPrice: order.avgFillPrice,
            // Backfill plan linkage when provided (handles stream-before-persist race)
            ...(order.executionPlanId && !existing[0]!.executionPlanId && { executionPlanId: order.executionPlanId }),
            ...(order.clientOrderId && !existing[0]!.clientOrderId && { clientOrderId: order.clientOrderId }),
            updatedAt: new Date(),
          })
          .where(eq(orders.venueRefId, order.venueRefId));
      } else {
        await tx.insert(orders).values({
          id: order.id ?? crypto.randomUUID(),
          venueAccountId: order.venueAccountId,
          actorType: order.actorType ?? 'system',
          actorId: order.actorId ?? null,
          executionPlanId: order.executionPlanId,
          venueRefId: order.venueRefId,
          clientOrderId: order.clientOrderId,
          venue: order.venue,
          symbol: order.symbol,
          side: order.side,
          type: order.type,
          quantity: order.quantity,
          price: order.price,
          status: order.status,
          filledQuantity: order.filledQuantity ?? '0',
          avgFillPrice: order.avgFillPrice,
        });
      }
    });
  }
}

export interface InsertBalanceSnapshot {
  venueAccountId: string;
  venue: string;
  balances: Array<{ asset: string; free: string; locked: string; total: string }>;
  markSource?: string;
  snapshotAt: Date;
}

/**
 * Repository for balance snapshot persistence and queries.
 */
export class BalanceSnapshotRepository {
  constructor(private readonly db: Database) {}

  /** Persist a point-in-time balance snapshot */
  async insertSnapshot(snapshot: InsertBalanceSnapshot): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.insert(balanceSnapshots).values({
      id,
      venueAccountId: snapshot.venueAccountId,
      venue: snapshot.venue,
      balances: snapshot.balances,
      markSource: snapshot.markSource ?? null,
      snapshotAt: snapshot.snapshotAt,
    });
    return id;
  }

  /** Get the latest balance snapshot for a venue account on a specific venue */
  async getLatestByVenueAccount(venueAccountId: string, venue: string) {
    const [row] = await this.db
      .select()
      .from(balanceSnapshots)
      .where(and(eq(balanceSnapshots.venueAccountId, venueAccountId), eq(balanceSnapshots.venue, venue)))
      .orderBy(desc(balanceSnapshots.snapshotAt))
      .limit(1);
    return row ?? null;
  }
}

export interface InsertDecision {
  id: string;
  venueAccountId: string;
  instrumentId: string;
  intent: string;
  targetSize: string;
  limitPrice?: string;
  contextHash?: string;
  actorType?: string;
  actorId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Repository for persisting strategy decisions (append-only).
 */
export class DecisionRepository {
  constructor(private readonly db: Database) {}

  async insertDecision(decision: InsertDecision): Promise<void> {
    await this.db.insert(decisions).values({
      id: decision.id,
      venueAccountId: decision.venueAccountId,
      instrumentId: decision.instrumentId,
      intent: decision.intent,
      targetSize: decision.targetSize,
      limitPrice: decision.limitPrice ?? null,
      contextHash: decision.contextHash ?? null,
      actorType: decision.actorType ?? 'system',
      actorId: decision.actorId ?? null,
      metadata: decision.metadata ?? null,
    });
  }

  /** Get decisions for an actor ordered by most recent first */
  async getByActor(actorType: string, actorId: string, limit = 50) {
    return this.db
      .select()
      .from(decisions)
      .where(
        and(
          eq(decisions.actorType, actorType),
          eq(decisions.actorId, actorId),
        ),
      )
      .orderBy(desc(decisions.createdAt))
      .limit(limit);
  }

  /** Get recent decisions for a venue account ordered by most recent first */
  async getByVenueAccount(venueAccountId: string, limit = 50) {
    return this.db
      .select()
      .from(decisions)
      .where(eq(decisions.venueAccountId, venueAccountId))
      .orderBy(desc(decisions.createdAt))
      .limit(limit);
  }
}

/**
 * Repository for bot persistence and queries.
 */
export class BotRepository {
  constructor(private readonly db: Database) {}

  /** Get a single bot by ID. */
  async getBotById(botId: string) {
    const [row] = await this.db.select().from(bots).where(eq(bots.id, botId)).limit(1);
    return row ?? null;
  }

  /** Create a bot record. Returns the created bot's ID. */
  async createBot(params: {
    userId: string;
    tradingBindingId: string;
    venueAccountId: string;
    config: Record<string, unknown>;
    creatorType: string;
    creatorId: string;
  }): Promise<string> {
    const id = crypto.randomUUID();
    const now = new Date();
    await this.db.insert(bots).values({
      id,
      userId: params.userId,
      venueAccountId: params.venueAccountId,
      tradingBindingId: params.tradingBindingId,
      config: params.config,
      status: 'stopped',
      creatorType: params.creatorType,
      creatorId: params.creatorId,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }

  /** Get all bots created by an actor (agent, user, or system) */
  async getBotsByCreator(creatorType: string, creatorId: string, since?: Date) {
    const conditions = [eq(bots.creatorType, creatorType), eq(bots.creatorId, creatorId)];
    if (since) {
      conditions.push(gte(bots.createdAt, since));
    }

    return this.db
      .select()
      .from(bots)
      .where(and(...conditions))
      .orderBy(desc(bots.createdAt));
  }

  /** Count running bots for an actor — used by broker to enforce maxBotsPerAgent limit */
  async countRunningBotsByCreator(creatorType: string, creatorId: string): Promise<number> {
    const rows = await this.db
      .select({ id: bots.id })
      .from(bots)
      .where(
        and(
          eq(bots.creatorType, creatorType),
          eq(bots.creatorId, creatorId),
          eq(bots.status, 'running'),
        ),
      );
    return rows.length;
  }

  /** Update bot config JSON in place. */
  async updateBotConfig(botId: string, config: Record<string, unknown>): Promise<void> {
    await this.db
      .update(bots)
      .set({ config, updatedAt: new Date() })
      .where(eq(bots.id, botId));
  }

  /** Restore a bot config snapshot after a failed follow-up side effect. */
  async restoreBotConfig(botId: string, config: Record<string, unknown>): Promise<void> {
    await this.db
      .update(bots)
      .set({ config, updatedAt: new Date() })
      .where(eq(bots.id, botId));
  }

  /** Mark a bot as stopped. */
  async markBotStopped(botId: string): Promise<void> {
    await this.db
      .update(bots)
      .set({ status: 'stopped', stoppedAt: new Date(), updatedAt: new Date() })
      .where(eq(bots.id, botId));
  }

  /** Mark a bot as crashed. */
  async markBotCrashed(botId: string): Promise<void> {
    await this.db
      .update(bots)
      .set({ status: 'crashed', stoppedAt: new Date(), updatedAt: new Date() })
      .where(eq(bots.id, botId));
  }

  /**
   * Mark a bot as running. Called just before the lifecycle start job is enqueued
   * so that the DB status matches the API start-bot path behaviour.
   */
  async markBotRunning(botId: string): Promise<void> {
    await this.db
      .update(bots)
      .set({ status: 'running', startedAt: new Date(), updatedAt: new Date() })
      .where(eq(bots.id, botId));
  }

  /** Restore the prior runtime fields after a failed lifecycle enqueue. */
  async restoreBotRuntimeState(params: {
    botId: string;
    status: string;
    startedAt?: Date | null;
    stoppedAt?: Date | null;
  }): Promise<void> {
    await this.db
      .update(bots)
      .set({
        status: params.status,
        startedAt: params.startedAt ?? null,
        stoppedAt: params.stoppedAt ?? null,
        updatedAt: new Date(),
      })
      .where(eq(bots.id, params.botId));
  }

  /**
   * Confirm that a trading binding exists and belongs to the given user.
   * Used by the broker before creating a bot on behalf of an agent.
   */
  async isTradingBindingOwnedBy(tradingBindingId: string, userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: tradingBindings.id })
      .from(tradingBindings)
      .where(and(eq(tradingBindings.id, tradingBindingId), eq(tradingBindings.userId, userId)));
    return !!row;
  }

  /**
   * Confirm that a venue account exists and belongs to the given user.
   * Used by the broker before creating a bot on behalf of an agent.
   */
  async isVenueAccountOwnedBy(venueAccountId: string, userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: venueAccounts.id })
      .from(venueAccounts)
      .where(and(eq(venueAccounts.id, venueAccountId), eq(venueAccounts.userId, userId)));
    return !!row;
  }

  /** Open positions for all bots created by the given actor. */
  async getOpenPositionsByCreator(creatorType: string, creatorId: string, botId?: string) {
    const botRows = await this.getBotsForQuery(creatorType, creatorId, undefined, botId);
    const botIds = botRows.map((row) => row.id);
    if (botIds.length === 0) return [];

    return this.db
      .select()
      .from(positions)
      .where(and(eq(positions.actorType, 'bot'), inArray(positions.actorId, botIds), isNull(positions.closedAt)))
      .orderBy(desc(positions.updatedAt));
  }

  /** Recent fills for all bots created by the given actor. */
  async getRecentFillsByCreator(creatorType: string, creatorId: string, since?: Date, botId?: string) {
    const botRows = await this.getBotsForQuery(creatorType, creatorId, since, botId);
    const botIds = botRows.map((row) => row.id);
    if (botIds.length === 0) return [];

    const conditions = [eq(fills.actorType, 'bot'), inArray(fills.actorId, botIds)];
    if (since) {
      conditions.push(gte(fills.filledAt, since));
    }

    return this.db
      .select()
      .from(fills)
      .where(and(...conditions))
      .orderBy(desc(fills.filledAt));
  }

  /** Compute lightweight bot analytics for all bots created by the given actor. */
  async getAnalyticsByCreator(creatorType: string, creatorId: string, since?: Date, botId?: string) {
    const botRows = await this.getBotsForQuery(creatorType, creatorId, since, botId);
    const botIds = botRows.map((row) => row.id);
    if (botIds.length === 0) {
      return {
        botCount: 0,
        openPositions: 0,
        closedPositions: 0,
        winningPositions: 0,
        realizedPnlUsd: '0',
        totalFeesUsd: '0',
        recentFills: 0,
      };
    }

    const positionRows = await this.db
      .select()
      .from(positions)
      .where(and(eq(positions.actorType, 'bot'), inArray(positions.actorId, botIds)));

    const fillRows = await this.getRecentFillsByCreator(creatorType, creatorId, since, botId);
    const openPositions = positionRows.filter((row) => row.closedAt == null);
    const closedPositions = positionRows.filter((row) => row.closedAt != null);
    const winningPositions = closedPositions.filter((row) => Number(row.realizedPnl ?? 0) > 0).length;
    const realizedPnlUsd = positionRows.reduce((sum, row) => sum + Number(row.realizedPnl ?? 0), 0);
    const totalFeesUsd = fillRows.reduce((sum, row) => sum + Number(row.fee ?? 0), 0);

    return {
      botCount: botRows.length,
      openPositions: openPositions.length,
      closedPositions: closedPositions.length,
      winningPositions,
      realizedPnlUsd: realizedPnlUsd.toFixed(2),
      totalFeesUsd: totalFeesUsd.toFixed(2),
      recentFills: fillRows.length,
    };
  }

  private async getBotsForQuery(creatorType: string, creatorId: string, since?: Date, botId?: string) {
    if (botId) {
      const bot = await this.getBotById(botId);
      if (!bot || bot.creatorType !== creatorType || bot.creatorId !== creatorId) {
        throw new Error(`Bot ${botId} not found or does not belong to ${creatorType}:${creatorId}`);
      }
      return [bot];
    }

    return this.getBotsByCreator(creatorType, creatorId, since);
  }
}