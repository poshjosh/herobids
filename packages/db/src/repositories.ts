import crypto from 'node:crypto';
import { eq, and, isNull, inArray, desc, or, gte, notInArray } from 'drizzle-orm';
import type { Database } from './index.js';
import { fills, positions, tradingInstances, executionPlans, orders, balanceSnapshots, decisions } from './schema/index.js';

export interface InsertFill {
  orderId: string;
  tradingInstanceId: string;
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
  tradingInstanceId: string;
  venueAccountId: string;
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
      tradingInstanceId: fill.tradingInstanceId,
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

  /** Get recent fills for a trading instance, optionally since a timestamp */
  async getRecentByInstance(tradingInstanceId: string, since?: Date, limit?: number) {
    const conditions = [eq(fills.tradingInstanceId, tradingInstanceId)];
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

  /** Get recent fills for ALL instances sharing a venue account.
   *  Prevents false unknown_fill drift when venue fills are fetched account-wide
   *  but local fills were previously scoped to a single instance. */
  async getRecentByVenueAccount(venueAccountId: string, since?: Date) {
    const conditions = [eq(tradingInstances.venueAccountId, venueAccountId)];
    if (since) {
      conditions.push(gte(fills.filledAt, since));
    }
    return this.db
      .select({
        id: fills.id,
        orderId: fills.orderId,
        tradingInstanceId: fills.tradingInstanceId,
        venueRefId: fills.venueRefId,
        venue: fills.venue,
        symbol: fills.symbol,
        side: fills.side,
        quantity: fills.quantity,
        price: fills.price,
        fee: fills.fee,
        feeCurrency: fills.feeCurrency,
        filledAt: fills.filledAt,
        createdAt: fills.createdAt,
      })
      .from(fills)
      .innerJoin(tradingInstances, eq(fills.tradingInstanceId, tradingInstances.id))
      .where(and(...conditions))
      .orderBy(desc(fills.filledAt));
  }

  async getLatestFillByInstrument(instrument: string, tradingInstanceId?: string): Promise<{ price: string; filledAt: string } | null> {
    const conditions = [eq(fills.symbol, instrument)];
    if (tradingInstanceId) {
      conditions.push(eq(fills.tradingInstanceId, tradingInstanceId));
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

  /** Upsert the current position for a trading instance + symbol */
  async upsert(pos: UpsertPosition): Promise<void> {
    // Find existing open position for this instance+symbol
    const existing = await this.db
      .select()
      .from(positions)
      .where(
        and(
          eq(positions.tradingInstanceId, pos.tradingInstanceId),
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
        tradingInstanceId: pos.tradingInstanceId,
        venueAccountId: pos.venueAccountId,
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

  /** Get open positions for a trading instance */
  async getOpenByInstance(tradingInstanceId: string) {
    return this.db
      .select()
      .from(positions)
      .where(
        and(
          eq(positions.tradingInstanceId, tradingInstanceId),
          isNull(positions.closedAt),
        ),
      );
  }

  /** Get all positions for a trading instance (including closed) */
  async getAllByInstance(tradingInstanceId: string) {
    return this.db
      .select()
      .from(positions)
      .where(eq(positions.tradingInstanceId, tradingInstanceId))
      .orderBy(desc(positions.updatedAt));
  }

  /** Get all positions across all instances in a portfolio */
  async getAllByPortfolio(portfolioId: string) {
    // Get instance IDs for this portfolio
    const instances = await this.db
      .select({ id: tradingInstances.id })
      .from(tradingInstances)
      .where(eq(tradingInstances.portfolioId, portfolioId));

    if (instances.length === 0) return [];

    const instanceIds = instances.map((i) => i.id);
    return this.db
      .select()
      .from(positions)
      .where(inArray(positions.tradingInstanceId, instanceIds))
      .orderBy(desc(positions.updatedAt));
  }

  /** Get open positions across all instances in a portfolio */
  async getOpenByPortfolio(portfolioId: string) {
    const instances = await this.db
      .select({ id: tradingInstances.id })
      .from(tradingInstances)
      .where(eq(tradingInstances.portfolioId, portfolioId));

    if (instances.length === 0) return [];

    const instanceIds = instances.map((i) => i.id);
    return this.db
      .select()
      .from(positions)
      .where(
        and(
          inArray(positions.tradingInstanceId, instanceIds),
          isNull(positions.closedAt),
        ),
      )
      .orderBy(desc(positions.updatedAt));
  }
}

export interface InsertExecutionPlan {
  id: string;
  decisionId: string;
  tradingInstanceId: string;
  venue: string;
  symbol: string;
  action: string;
  plannedOrders: unknown[];
}

export interface UpsertOrder {
  id?: string;
  tradingInstanceId: string;
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
      tradingInstanceId: plan.tradingInstanceId,
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

  /** Find incomplete plans for a trading instance (pending or executing — not terminal) */
  async getIncomplete(tradingInstanceId: string) {
    return this.db
      .select()
      .from(executionPlans)
      .where(
        and(
          eq(executionPlans.tradingInstanceId, tradingInstanceId),
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

  /** Get open (non-terminal) orders for a trading instance */
  async getOpenByInstance(tradingInstanceId: string) {
    return this.db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.tradingInstanceId, tradingInstanceId),
          notInArray(orders.status, TERMINAL_ORDER_STATUSES),
        ),
      )
      .orderBy(desc(orders.createdAt));
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
          tradingInstanceId: order.tradingInstanceId,
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
  tradingInstanceId: string;
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
      tradingInstanceId: decision.tradingInstanceId,
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

  /** Get decisions for a trading instance ordered by most recent first */
  async getByInstance(tradingInstanceId: string, limit = 50) {
    return this.db
      .select()
      .from(decisions)
      .where(eq(decisions.tradingInstanceId, tradingInstanceId))
      .orderBy(desc(decisions.createdAt))
      .limit(limit);
  }
}
