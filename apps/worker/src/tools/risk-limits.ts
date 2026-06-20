import { z } from 'zod';
import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';

// --- get_risk_limits ---

const GetRiskLimitsParamsSchema = z.object({});

const getRiskLimitsTool: AgentTool = {
  name: 'get_risk_limits',
  description: 'Get the effective risk limits for this agent, including which limits are mutable (adjustable) and which are locked by the creator. Shows effective values, sources, operator ceilings, and mutability for each risk field.',
  parametersSchema: GetRiskLimitsParamsSchema,
  parameters: convertZodToJsonSchema(GetRiskLimitsParamsSchema),
  category: 'read-database',
  async execute(_params: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.riskContractOps) {
      return { success: false, error: 'risk contract not available in this context' };
    }

    const contract = await ctx.riskContractOps.getContract();

    return {
      success: true,
      data: {
        ok: true,
        limits: {
          maxOpenPositions: formatField(contract.maxOpenPositions),
          maxPositionSizePct: formatField(contract.maxPositionSizePct),
          stopLossPct: formatField(contract.stopLossPct),
          stopLossCooldownMs: formatField(contract.stopLossCooldownMs),
        },
      },
    };
  },
};

// --- adjust_risk_limits ---

const AdjustRiskLimitsParamsSchema = z.object({
  maxOpenPositions: z.number().int().positive().optional().nullable().describe('Max concurrent open positions. Set null to reset to operator default.'),
  maxPositionSizePct: z.number().min(0).max(100).optional().nullable().describe('Max position size as % of equity (0-100). Set null to reset to operator default.'),
  stopLossPct: z.number().min(0).max(100).optional().nullable().describe('Unrealized loss % threshold for stop-loss (0-100). Set null to reset to operator default.'),
  stopLossCooldownMs: z.number().int().min(0).optional().nullable().describe('Cooldown in ms after stop-loss exit before re-entry. Set null to reset to operator default.'),
});

const adjustRiskLimitsTool: AgentTool = {
  name: 'adjust_risk_limits',
  description: 'Adjust mutable risk limits for this agent. Only limits derived from operator defaults (not creator-configured) can be changed. Values cannot exceed operator ceilings. Set a field to null to reset it to the operator default.',
  parametersSchema: AdjustRiskLimitsParamsSchema,
  parameters: convertZodToJsonSchema(AdjustRiskLimitsParamsSchema),
  category: 'write-database',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.riskContractOps) {
      return { success: false, error: 'risk contract not available in this context' };
    }

    const p = params as z.infer<typeof AdjustRiskLimitsParamsSchema>;

    // Collect only fields that were explicitly provided
    const overrides: Record<string, number | null> = {};
    if (p.maxOpenPositions !== undefined) overrides.maxOpenPositions = p.maxOpenPositions ?? null;
    if (p.maxPositionSizePct !== undefined) overrides.maxPositionSizePct = p.maxPositionSizePct ?? null;
    if (p.stopLossPct !== undefined) overrides.stopLossPct = p.stopLossPct ?? null;
    if (p.stopLossCooldownMs !== undefined) overrides.stopLossCooldownMs = p.stopLossCooldownMs ?? null;

    if (Object.keys(overrides).length === 0) {
      return { success: false, error: 'No fields provided to adjust', fault: false };
    }

    const result = await ctx.riskContractOps.adjustOverrides(overrides);

    if (!result.ok) {
      return { success: false, error: result.error, fault: false };
    }

    return {
      success: true,
      data: {
        ok: true,
        note: 'Risk limits updated. Changes take effect on next decision cycle.',
        limits: result.contract ? {
          maxOpenPositions: formatField(result.contract.maxOpenPositions),
          maxPositionSizePct: formatField(result.contract.maxPositionSizePct),
          stopLossPct: formatField(result.contract.stopLossPct),
          stopLossCooldownMs: formatField(result.contract.stopLossCooldownMs),
        } : undefined,
      },
    };
  },
};

function formatField(field: { effectiveValue: number; source: string; mutable: boolean; operatorCeiling: number; enforced?: boolean }) {
  return {
    value: field.effectiveValue,
    source: field.source,
    mutable: field.mutable,
    ceiling: field.operatorCeiling,
    ...(field.enforced === false ? { enforced: false } : {}),
  };
}

export const riskLimitsTools: AgentTool[] = [
  getRiskLimitsTool,
  adjustRiskLimitsTool,
];
