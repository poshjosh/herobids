import crypto from 'node:crypto';
import { eq, and, isNull, inArray, desc, or } from 'drizzle-orm';
import type { Database } from './index.js';
import { fills, positions, tradingInstances, executionPlans } from './schema/index.js';

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
