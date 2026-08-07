import { eq, and, or, inArray, sql } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { blueprints, agents, bots, positions } from '@herobids/db';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Recompute and persist the `performanceScore` on a blueprint.
 *
 * Score is derived from the trading performance of the original author's agent
 * (the agent owned by `blueprints.authorId` whose `blueprintId` matches this
 * blueprint) and all bots created by that agent.
 *
 * Phase 1 formula uses 3 of 4 components (drawdown is neutral 0.5):
 *   pnlScore         = clamp((pnlReturnPct + 5) / 10, 0, 1)        // weight 0.4
 *   winRateScore     = clamp(winRate / 100, 0, 1)                  // weight 0.2
 *   riskAdjustedScore = clamp((riskAdjustedReturn + 1) / 3, 0, 1)  // weight 0.2
 *   drawdownScore    = 0.5                                          // weight 0.2 (Phase 1 neutral)
 *   weightedScore    = pnlScore*0.4 + winRateScore*0.2 + riskAdjustedScore*0.2 + drawdownScore*0.2
 *   performanceScore = clamp(round(weightedScore * 10), 1, 10)
 *
 * Edge cases:
 * - No closed positions → performanceScore = 0 (sorts to bottom)
 * - Fewer than 2 closed positions → winRateScore = 0.5 (neutral)
 * - No capital set (agents.capital IS NULL) → pnlScore = 0.5, riskAdjustedScore = 0.5 (neutral)
 */
export async function recomputeBlueprintPerformanceScore(
  db: Database,
  blueprintId: string,
): Promise<void> {
  // 1. Resolve the blueprint to get authorId
  const [bp] = await db
    .select({ authorId: blueprints.authorId })
    .from(blueprints)
    .where(eq(blueprints.id, blueprintId))
    .limit(1);
  if (!bp) return;

  // 2. Look up the original author's agent for this blueprint
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.userId, bp.authorId), eq(agents.blueprintId, blueprintId)))
    .limit(1);

  if (!agent) {
    await db
      .update(blueprints)
      .set({ performanceScore: 0, updatedAt: new Date() })
      .where(eq(blueprints.id, blueprintId));
    return;
  }

  // 3. Get all bots created by this agent
  const agentBots = await db
    .select({ id: bots.id })
    .from(bots)
    .where(and(eq(bots.creatorType, 'agent'), eq(bots.creatorId, agent.id)));
  const botIds = agentBots.map((b) => b.id);

  // 4. Query closed positions for agent-direct AND bot positions
  const agentDirectCondition = and(
    eq(positions.actorType, 'agent'),
    eq(positions.actorId, agent.id),
    sql`${positions.closedAt} IS NOT NULL`,
  );

  const botCondition =
    botIds.length > 0
      ? and(
          eq(positions.actorType, 'bot'),
          inArray(positions.actorId, botIds),
          sql`${positions.closedAt} IS NOT NULL`,
        )
      : undefined;

  const positionWhereClause = botCondition
    ? or(agentDirectCondition, botCondition)
    : agentDirectCondition;

  const closedPositions = await db.select().from(positions).where(positionWhereClause);

  // 5. Edge case: no closed positions → zero score (sorts to bottom)
  if (closedPositions.length === 0) {
    await db
      .update(blueprints)
      .set({ performanceScore: 0, updatedAt: new Date() })
      .where(eq(blueprints.id, blueprintId));
    return;
  }

  // 6. Compute raw metrics
  const totalClosed = closedPositions.length;
  const winningPositions = closedPositions.filter((p) => Number(p.realizedPnl ?? 0) > 0).length;
  const realizedPnlUsd = closedPositions.reduce((sum, p) => sum + Number(p.realizedPnl ?? 0), 0);

  // --- winRateScore ---
  let winRateScore = 0.5; // neutral when < 2 closed positions
  if (totalClosed >= 2) {
    const winRate = (winningPositions / totalClosed) * 100;
    winRateScore = clamp(winRate / 100, 0, 1);
  }

  // --- pnlScore (and riskAdjustedScore, which depends on it) ---
  const capital = agent.capital ? Number(agent.capital) : null;
  let pnlScore = 0.5; // neutral when no capital set
  let riskAdjustedScore = 0.5; // neutral when no capital set

  if (capital !== null && capital > 0) {
    const pnlReturnPct = (realizedPnlUsd / capital) * 100;
    pnlScore = clamp((pnlReturnPct + 5) / 10, 0, 1);

    const hoursSinceCreation = (Date.now() - agent.createdAt.getTime()) / 3_600_000;
    const effectiveHours = Math.max(hoursSinceCreation, 1 / 60);
    const riskAdjustedReturn = pnlReturnPct / Math.sqrt(effectiveHours);
    riskAdjustedScore = clamp((riskAdjustedReturn + 1) / 3, 0, 1);
  }

  // --- drawdownScore (Phase 1: neutral) ---
  const drawdownScore = 0.5;

  // 7. Compute weighted score
  const weightedScore =
    pnlScore * 0.4 + winRateScore * 0.2 + riskAdjustedScore * 0.2 + drawdownScore * 0.2;
  const performanceScore = clamp(Math.round(weightedScore * 10), 1, 10);

  // 8. Persist
  await db
    .update(blueprints)
    .set({ performanceScore, updatedAt: new Date() })
    .where(eq(blueprints.id, blueprintId));
}
