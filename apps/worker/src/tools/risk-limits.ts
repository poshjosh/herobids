import { z } from 'zod';
import type { AgentTool, ToolResult, TradingToolContext, ResolvedAgentRiskContract, ResolvedAgentRiskProfile, AgentRiskProfileField } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';
import { mapReadResultToToolResult, mapWriteResultToToolResult } from './traderton-read.js';

/** Deadline for the adjust_risk_limits boundary write (invoke + poll), in ms. */
const ADJUST_RISK_LIMITS_DEADLINE_MS = 30_000;

// --- get_risk_limits ---

const GetRiskLimitsParamsSchema = z.object({});

const getRiskLimitsTool: AgentTool<TradingToolContext> = {
  name: 'get_risk_limits',
  description: 'Get the effective risk limits for this agent, including which limits are mutable (adjustable) and which are locked by the creator. Also shows current runtime state against those limits (open position count, daily P&L vs loss limit, drawdown). Shows effective values, sources, operator ceilings, and mutability for each risk field.',
  parametersSchema: GetRiskLimitsParamsSchema,
  parameters: convertZodToJsonSchema(GetRiskLimitsParamsSchema),
  category: 'read-database',
  async execute(_params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    // L3: route the read through the Traderton boundary when configured. The
    // Traderton `get_risk_limits` tool returns the identical composite shape
    // (limits 5+4 + runtime), so parity holds by construction. Read-fallback
    // posture: when the boundary is absent, fall back to the in-process
    // riskContractOps read (transitional, unlike the fail-closed adjust write).
    if (ctx.tradertonBoundary) {
      const result = await ctx.tradertonBoundary.invoke({ toolName: 'get_risk_limits', payload: {} });
      return mapReadResultToToolResult(result);
    }

    if (!ctx.riskContractOps) {
      return { success: false, error: 'risk contract not available in this context' };
    }

    const contract = await ctx.riskContractOps.getContract();
    const runtime = await buildRuntime(ctx, contract);

    // Resolve the full 9-field profile for read-only fields (graceful degradation if unavailable)
    let profile: ResolvedAgentRiskProfile | undefined;
    if (ctx.riskContractOps.getProfile) {
      try {
        profile = await ctx.riskContractOps.getProfile();
      } catch { /* Non-critical — proceed with 5-field contract only */ }
    }

    return {
      success: true,
      data: {
        ok: true,
        limits: {
          // 5 mutable fields from the contract
          maxOpenPositions: formatField(contract.maxOpenPositions),
          maxPositionSizePct: formatField(contract.maxPositionSizePct),
          stopLossPct: formatField(contract.stopLossPct),
          stopLossCooldownMs: formatField(contract.stopLossCooldownMs),
          maxDrawdownPct: formatField(contract.maxDrawdownPct),
          // 4 read-only fields from the profile (informational only)
          dailyMaxLossPct: profile
            ? formatProfileField(profile.dailyMaxLossPct)
            : { value: null, source: 'unavailable', mutable: false, ceiling: null },
          maxNewPositionsPerDay: profile
            ? formatProfileField(profile.maxNewPositionsPerDay)
            : { value: null, source: 'unavailable', mutable: false, ceiling: null },
          avoidParabolicMovePct: profile
            ? formatProfileField(profile.avoidParabolicMovePct)
            : { value: null, source: 'unavailable', mutable: false, ceiling: null },
          maxOrderNotional: profile
            ? formatProfileField(profile.maxOrderNotional)
            : { value: null, source: 'unavailable', mutable: false, ceiling: null },
        },
        runtime,
      },
    };
  },
};

// --- adjust_risk_limits ---

const AdjustRiskLimitsParamsSchema = z.object({
  maxOpenPositions: z.number().int().positive().optional().nullable().describe('Max concurrent open positions. Set null to reset to operator default.'),
  maxPositionSizePct: z.number().min(0).max(100).optional().nullable().describe('Max position size as % of equity (0-100). Set null to reset to operator default.'),
  stopLossPct: z.number().min(0).max(100).optional().nullable().describe('Max unrealized loss per position as % of equity before forced exit (0-100). Set null to reset to operator default.'),
  stopLossCooldownMs: z.number().int().min(0).optional().nullable().describe('Cooldown in ms after stop-loss exit before re-entry. Set null to reset to operator default.'),
  maxDrawdownPct: z.number().min(0).max(100).optional().nullable().describe('Max peak-to-current equity drawdown % (0-100). Set null to reset to operator default.'),
});

const adjustRiskLimitsTool: AgentTool<TradingToolContext> = {
  name: 'adjust_risk_limits',
  description: 'Adjust mutable risk limits for this agent. Only limits derived from operator defaults (not creator-configured) can be changed. Values cannot exceed operator ceilings. Set a field to null to reset it to the operator default. maxDrawdownPct controls peak-to-current equity drawdown (separate from dailyLossLimit which controls rolling 24h realized loss).',
  parametersSchema: AdjustRiskLimitsParamsSchema,
  parameters: convertZodToJsonSchema(AdjustRiskLimitsParamsSchema),
  category: 'write-database',
  async execute(params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    const p = params as z.infer<typeof AdjustRiskLimitsParamsSchema>;

    // Collect only fields that were explicitly provided
    const overrides: Record<string, number | null> = {};
    if (p.maxOpenPositions !== undefined) overrides.maxOpenPositions = p.maxOpenPositions ?? null;
    if (p.maxPositionSizePct !== undefined) overrides.maxPositionSizePct = p.maxPositionSizePct ?? null;
    if (p.stopLossPct !== undefined) overrides.stopLossPct = p.stopLossPct ?? null;
    if (p.stopLossCooldownMs !== undefined) overrides.stopLossCooldownMs = p.stopLossCooldownMs ?? null;
    if (p.maxDrawdownPct !== undefined) overrides.maxDrawdownPct = p.maxDrawdownPct ?? null;

    if (Object.keys(overrides).length === 0) {
      return { success: false, error: 'No fields provided to adjust', fault: false };
    }

    // L3d: route the risk-limit WRITE through the Traderton side-effecting
    // boundary. Traderton owns the risk contract; herobids no longer mutates it
    // in-process. FAIL-CLOSED — when the write boundary is absent we return a
    // typed precondition rather than falling back to ctx.riskContractOps (the
    // read path `get_risk_limits` still uses riskContractOps). The boundary
    // returns the same success shape this tool built in-process, so parity holds.
    if (!ctx.tradertonWriteBoundary) {
      return {
        success: false,
        error: 'trading boundary not configured',
        errorCode: 'precondition.not_ready',
        fault: false,
      };
    }

    const result = await ctx.tradertonWriteBoundary.invokeAndAwait({
      toolName: 'adjust_risk_limits',
      payload: overrides,
      deadlineMs: ADJUST_RISK_LIMITS_DEADLINE_MS,
    });

    return mapWriteResultToToolResult(result);
  },
};

/**
 * Build the runtime risk snapshot for an agent.
 *
 * Conventions:
 * - dailyMaxLossPct === 0 means "no daily loss limit configured" — treated as unlimited.
 * - drawdown is engine-only state populated during decision execution; not available here.
 */
async function buildRuntime(ctx: TradingToolContext, contract: ResolvedAgentRiskContract) {
  // --- openPositions ---
  let openPositionsCurrent = 0;
  const openPositionsLimit = contract.maxOpenPositions.effectiveValue;

  // --- dailyLoss ---
  let dailyLossCurrent: string | null = null;
  let dailyLossLimit: string | null = null;
  let dailyLossLimitPct: number | null = null;
  let dailyLossBlocked = false;

  if (ctx.botRepo) {
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const [positions, analytics] = await Promise.all([
        ctx.botRepo.getOpenPositionsByCreator('agent', ctx.agentId),
        ctx.botRepo.getAnalyticsByCreator('agent', ctx.agentId, since),
      ]);
      openPositionsCurrent = positions.filter((p) => p.size !== '0').length;
      dailyLossCurrent = analytics.realizedPnlUsd;
    } catch {
      // Non-critical: use defaults (openPositionsCurrent stays 0, dailyLossCurrent stays null)
    }
  } else {
    dailyLossCurrent = '0';
  }

  const openPositionsBlocked = openPositionsCurrent >= openPositionsLimit;

  // Derive the daily loss limit from the canonical agents.risk.dailyMaxLossPct column.
  // No legacy fallback to dailyLossLimit — that column is deprecated.
  let dailyLossLimitFromUser = false;
  if (ctx.agentRepo) {
    try {
      const agent = await ctx.agentRepo.getAgent(ctx.agentId);
      const risk = (agent?.risk ?? {}) as Record<string, unknown> | null;
      if (risk?.['dailyMaxLossPct'] != null) {
        dailyLossLimitPct = Number(risk['dailyMaxLossPct']);
        dailyLossLimitFromUser = true;
      }
      if (dailyLossLimitPct != null && dailyLossLimitPct > 0 && agent?.capital) {
        const capital = Number(agent.capital);
        if (!Number.isNaN(capital) && capital > 0) {
          dailyLossLimit = String(capital * dailyLossLimitPct / 100);
        }
      }
    } catch {
      // Non-critical
    }
  }

  // Blocked when today's realized loss (negative P&L) exceeds the limit.
  // dailyMaxLossPct === 0 means "no daily loss limit configured" — treat as unlimited.
  if (dailyLossCurrent != null && dailyLossLimit != null) {
    const currentNum = Number(dailyLossCurrent);
    const limitNum = Number(dailyLossLimit);
    if (!Number.isNaN(currentNum) && !Number.isNaN(limitNum) && limitNum > 0) {
      dailyLossBlocked = currentNum < 0 && Math.abs(currentNum) >= limitNum;
    }
  }

  // Resolve maxDrawdownPct from the risk contract (same provenance as other adjustable limits).
  // The contract handles creator→default→override resolution with mutability metadata.
  const drawdownPctField = contract.maxDrawdownPct;

  return {
    dailyLoss: {
      current: dailyLossCurrent,
      limit: dailyLossLimit,
      limitPct: dailyLossLimitPct,
      blocked: dailyLossBlocked,
      source: dailyLossLimitFromUser ? 'user_configured' : 'operator_default',
      oldestFillAgesOutAt: null,
      remainingMs: null,
    },
    drawdown: {
      // Current drawdown is engine-only state — populated from Redis cache
      // (equity:{actorId}) written by the worker after each decision.
      current: await resolveDrawdownCurrent(ctx),
      limit: drawdownPctField.effectiveValue > 0 ? String(drawdownPctField.effectiveValue) : null,
      limitPct: drawdownPctField.effectiveValue,
      source: drawdownPctField.source === 'user' ? 'user_configured' :
              drawdownPctField.source === 'agent_override' ? 'agent_override' : 'operator_default',
      mutable: drawdownPctField.mutable,
      ceiling: drawdownPctField.operatorCeiling,
      approaching: false,
    },
    openPositions: {
      current: openPositionsCurrent,
      limit: openPositionsLimit,
      blocked: openPositionsBlocked,
    },
  };
}

function formatField(field: { effectiveValue: number; source: string; mutable: boolean; operatorCeiling: number; enforced?: boolean }) {
  return {
    value: field.effectiveValue,
    source: field.source,
    mutable: field.mutable,
    ceiling: field.operatorCeiling,
    ...(field.enforced === false ? { enforced: false } : {}),
  };
}

/**
 * Format a read-only risk profile field for display in get_risk_limits.
 * Differs from formatField in that effectiveValue and operatorCeiling can be null.
 */
function formatProfileField(field: AgentRiskProfileField) {
  return {
    value: field.effectiveValue,
    source: field.source,
    mutable: field.mutable,
    ceiling: field.operatorCeiling,
    ...(field.enforced === false ? { enforced: false } : {}),
  };
}

/**
 * Read the current drawdown from the Redis equity cache.
 * The worker writes equity:{actorId} after each decision (see decision-intake.ts).
 */
async function resolveDrawdownCurrent(ctx: TradingToolContext): Promise<string | null> {
  try {
    const snapshot = await ctx.redis.hgetall(`equity:${ctx.agentId}`);
    if (snapshot && snapshot['currentDrawdown'] != null) {
      return snapshot['currentDrawdown'];
    }
  } catch { /* Redis unavailable — return null */ }
  return null;
}

export const riskLimitsTools: AgentTool<TradingToolContext>[] = [
  getRiskLimitsTool,
  adjustRiskLimitsTool,
];
