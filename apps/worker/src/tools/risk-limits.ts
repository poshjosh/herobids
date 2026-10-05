import { z } from 'zod';
import type { AgentTool, ToolResult, TradingToolContext } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';
import { mapReadResultToToolResult, mapWriteResultToToolResult } from './external-backend-result.js';

/** Deadline for the adjust_risk_limits boundary write (invoke + poll), in ms. */
const ADJUST_RISK_LIMITS_DEADLINE_MS = 30_000;

/**
 * Resolve the platform-selected venue account for an account-scoped boundary
 * call. Null when there is no resolver, it finds no ready account, or it fails.
 * Profile enforcement data stays Traderton-owned and never enters an LLM tool
 * schema.
 */
export async function resolveSelectedVenueAccountId(ctx: TradingToolContext): Promise<string | null> {
  if (!ctx.selectedVenueAccountResolver) return null;
  try {
    return await ctx.selectedVenueAccountResolver();
  } catch {
    // Treated as "no ready account": callers return a typed precondition
    // instead of throwing past the tool boundary.
    return null;
  }
}

/**
 * Typed result for an account-scoped tool when no venue account is ready.
 * Traderton requires `venueAccountId` on these calls, so sending an empty
 * payload would only produce a `validation.invalid_payload` rejection.
 */
export function selectedAccountUnavailable(): ToolResult {
  return {
    success: false,
    error: 'selected trading account is unavailable',
    errorCode: 'precondition.not_ready',
    fault: false,
  };
}

// --- get_risk_limits ---

const GetRiskLimitsParamsSchema = z.object({});

const getRiskLimitsTool: AgentTool<TradingToolContext> = {
  name: 'get_risk_limits',
  description: 'Get the effective risk limits for this agent, including which limits are mutable (adjustable) and which are locked by the creator. Also shows current runtime state against those limits (open position count, daily P&L vs loss limit, drawdown). Shows effective values, sources, operator ceilings, and mutability for each risk field.',
  parametersSchema: GetRiskLimitsParamsSchema,
  parameters: convertZodToJsonSchema(GetRiskLimitsParamsSchema),
  category: 'read-database',
  async execute(_params: unknown, ctx: TradingToolContext): Promise<ToolResult> {
    // A6: boundary-first, FAIL CLOSED when the read boundary is absent —
    // consistent with the adjust write's fail-closed posture. A3 landed the
    // boundary-side RiskSource seam, so the previous in-process riskContractOps
    // fallback is a split-brain trap (consumer would read its own numbers while
    // traderton enforces from the same payload) and is deleted.
    if (!ctx.externalBackend) {
      return {
        success: false,
        error: 'trading boundary not configured',
        errorCode: 'precondition.not_ready',
        fault: false,
      };
    }

    // The platform resolves the selected account. Traderton loads profile-owned
    // enforcement data from its durable profile store.
    const venueAccountId = await resolveSelectedVenueAccountId(ctx);
    if (!venueAccountId) return selectedAccountUnavailable();
    const result = await ctx.externalBackend.invoke({ toolName: 'get_risk_limits', payload: { venueAccountId } });
    return mapReadResultToToolResult(result);
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
    // typed precondition rather than falling back to ctx.riskContractOps. A6:
    // the read path `get_risk_limits` shares this fail-closed posture. The
    // boundary returns the same success shape this tool used to build
    // in-process, so parity holds.
    if (!ctx.externalBackendWrite) {
      return {
        success: false,
        error: 'trading boundary not configured',
        errorCode: 'precondition.not_ready',
        fault: false,
      };
    }

    const venueAccountId = await resolveSelectedVenueAccountId(ctx);
    if (!venueAccountId) return selectedAccountUnavailable();

    const result = await ctx.externalBackendWrite.invokeAndAwait({
      toolName: 'adjust_risk_limits',
      payload: { ...overrides, venueAccountId },
      deadlineMs: ADJUST_RISK_LIMITS_DEADLINE_MS,
    });

    return mapWriteResultToToolResult(result);
  },
};

export const riskLimitsTools: AgentTool<TradingToolContext>[] = [
  getRiskLimitsTool,
  adjustRiskLimitsTool,
];
