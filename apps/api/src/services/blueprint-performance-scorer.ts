import { eq, and, asc } from 'drizzle-orm';
import type { Database } from '@herobids/db';
import { blueprints, agents } from '@herobids/db';
import type { TradertonClient, TradertonSubject } from '@herobids/domain/traderton';
import {
  createTradertonReadBoundary,
  loadAgentEvidence,
  toPositionRow,
  type PositionRow as ReadPositionRow,
} from '../routes/exports-traderton.js';

const DEFAULT_READ_TIMEOUT_MS = 10_000;

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
 * Trading positions (agent-native + agent-owned-bot) are read over the Traderton
 * read boundary via `get_agent_positions`, which folds both scopes server-side
 * by agent id (the same `creatorType='agent'` / `creatorId=agent.id` scoping the
 * old local `bots` + `positions` reads used). It returns ALL (open + closed)
 * positions, so we filter `closedAt !== null` in-app to reproduce the old
 * closed-only set. The `blueprints` / `agents` reads + the `blueprints` UPDATE
 * stay local (platform reads).
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
 *
 * Best-effort posture (DELIBERATE divergence from the request endpoints, which
 * 503 when the boundary is unconfigured): this is a fire-and-forget background
 * recompute, NOT a user request. When `tradertonReadClient` is undefined, or the
 * boundary read fails, we SKIP the recompute — return early WITHOUT throwing and
 * WITHOUT overwriting the existing score. Zeroing the score on a transient
 * boundary gap would be a real degradation; the score is recomputed on the next
 * trigger instead. (See the coordinator's slice-c4.2 divergence note.)
 */
export async function recomputeBlueprintPerformanceScore(
  db: Database,
  blueprintId: string,
  tradertonReadClient?: TradertonClient,
  tradertonReadTimeoutMs?: number,
): Promise<void> {
  // Best-effort: without a read boundary we cannot source trading positions.
  // Skip rather than zeroing — the score is recomputed on the next trigger.
  if (!tradertonReadClient) {
    console.warn('Skipping blueprint performance score recompute — Traderton read client unconfigured', {
      blueprintId,
    });
    return;
  }

  // 1. Resolve the blueprint to get authorId
  const [bp] = await db
    .select({ authorId: blueprints.authorId })
    .from(blueprints)
    .where(eq(blueprints.id, blueprintId))
    .limit(1);
  if (!bp) return;

  // 2. Look up the original author's agent for this blueprint.
  //    Pick the oldest agent (by createdAt) when multiple agents exist
  //    for the same blueprint — deterministic tie-breaking.
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.userId, bp.authorId), eq(agents.blueprintId, blueprintId)))
    .orderBy(asc(agents.createdAt))
    .limit(1);

  if (!agent) {
    await db
      .update(blueprints)
      .set({ performanceScore: 0, updatedAt: new Date() })
      .where(eq(blueprints.id, blueprintId));
    return;
  }

  // 3. Read the author-agent's positions over the Traderton read boundary.
  //    `get_agent_positions` folds agent-native + agent-owned-bot positions
  //    server-side by the subject's agent id (replacing the old local `bots`
  //    botId-scoping + `positions` read). Subject: the author's user id is the
  //    owner, the agent is the actor (mirrors the c1 evidence-assembler).
  const subject: TradertonSubject = {
    ownerId: bp.authorId,
    actor: { type: 'agent', id: agent.id },
  };
  const boundary = createTradertonReadBoundary(
    tradertonReadClient,
    subject,
    tradertonReadTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS,
  );
  const loaded = await loadAgentEvidence<ReadPositionRow>(
    boundary,
    'get_agent_positions',
    {},
    'positions',
    toPositionRow,
  );
  // Best-effort: on a boundary read failure, skip rather than zeroing the score.
  if (!loaded.ok) {
    console.warn('Skipping blueprint performance score recompute — Traderton positions read failed', {
      blueprintId,
      code: loaded.error.code,
      message: loaded.error.message,
    });
    return;
  }

  // 4. Filter to CLOSED positions in-app (reproduces the old closed-only set).
  const closedPositions = loaded.rows.filter((p) => p.closedAt !== null);

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
