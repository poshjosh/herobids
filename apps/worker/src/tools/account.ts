import { z } from 'zod';
import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';
import pino from 'pino';

const logger = pino({ name: 'tools:account' });

// --- get_account_summary ---

const GetAccountSummaryParamsSchema = z.object({});

const getAccountSummaryTool: AgentTool = {
  name: 'get_account_summary',
  description: 'Get a summary of the agent\'s trading account including usable capital, equity, open positions, P&L, and risk limits. Use this to compute appropriate position sizes (targetSize) before calling submit_decision, or to determine sizing for position sizing configuration.',
  parametersSchema: GetAccountSummaryParamsSchema,
  parameters: convertZodToJsonSchema(GetAccountSummaryParamsSchema),
  category: 'read-database',
  promptGuidance: 'Call get_account_summary before submit_decision to see available capital and open positions. targetSize is in base units — the amount of the asset being bought or sold. If capital is unavailable, omit targetSize to let the engine use a safe default.',
  async execute(_params: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.botRepo) {
      return {
        success: false,
        fault: false,
        error: 'Database access not available in this context',
        errorCode: 'account.db_unavailable',
      };
    }

    try {
      // Gather positions for both agent-direct and bot-managed
      const allPositions = await ctx.botRepo.getOpenPositionsByCreator('agent', ctx.agentId);
      const agentPositions = allPositions.filter((p) => p.actorType === 'agent');
      const botPositions = allPositions.filter((p) => p.actorType === 'bot');

      // Collect warnings for partially-available data
      const warnings: string[] = [];

      // Get risk contract for current limits
      let riskContract: Record<string, unknown> | null = null;
      if (ctx.riskContractOps) {
        try {
          const contract = await ctx.riskContractOps.getContract();
          riskContract = {
            maxOpenPositions: contract.maxOpenPositions.effectiveValue,
            maxOpenPositionsSource: contract.maxOpenPositions.source,
            maxPositionSizePct: contract.maxPositionSizePct.effectiveValue,
            maxPositionSizePctSource: contract.maxPositionSizePct.source,
            stopLossPct: contract.stopLossPct.effectiveValue,
            stopLossPctSource: contract.stopLossPct.source,
            stopLossCooldownMs: contract.stopLossCooldownMs.effectiveValue,
          };
        } catch (err) {
          warnings.push('risk_contract_unavailable');
          logger.warn({ agentId: ctx.agentId, err }, 'get_account_summary: risk contract unavailable');
        }
      } else {
        warnings.push('risk_contract_unavailable');
      }

      // Get agent config for capital and sizing info
      let capital: string | null = null;
      let executionMode: string | null = null;
      let fixedPositionSize: string | null = null;
      let positionSizeMode: string | null = null;

      if (ctx.agentConfigOps) {
        try {
          const config = await ctx.agentConfigOps.getCurrentConfig();
          if (config) {
            executionMode = config.execution?.mode ?? null;
            fixedPositionSize = config.execution?.fixedPositionSize ?? null;
            positionSizeMode = config.execution?.positionSizeMode ?? null;
          }
        } catch (err) {
          warnings.push('agent_config_unavailable');
          logger.warn({ agentId: ctx.agentId, err }, 'get_account_summary: agent config unavailable');
        }
      } else {
        warnings.push('agent_config_unavailable');
      }

      // Get agent capital from agentRepo if available
      if (ctx.agentRepo) {
        try {
          const agent = await ctx.agentRepo.getAgent(ctx.agentId);
          if (agent) {
            capital = agent.capital;
          }
        } catch (err) {
          warnings.push('agent_repo_unavailable');
          logger.warn({ agentId: ctx.agentId, err }, 'get_account_summary: agent repo unavailable');
        }
      } else {
        warnings.push('agent_repo_unavailable');
      }

      // Count open positions
      const openPositionCount = agentPositions.length + botPositions.length;

      // Build position summaries
      const positions = allPositions.map((p) => ({
        actorType: p.actorType,
        actorId: p.actorId,
        symbol: p.symbol,
        side: p.side,
        size: p.size,
        entryPrice: p.entryPrice,
        openedAt: p.openedAt,
      }));

      return {
        success: true,
        data: {
          ok: true,
          agentId: ctx.agentId,
          capital: capital,
          capitalAvailable: capital !== null,
          executionMode: executionMode ?? 'unknown',
          positionSizeMode: positionSizeMode ?? 'unknown',
          fixedPositionSize: fixedPositionSize ?? null,
          openPositionCount,
          agentDirectPositions: agentPositions.length,
          botManagedPositions: botPositions.length,
          positions,
          riskLimits: riskContract ?? 'unavailable',
          warnings: warnings.length > 0 ? warnings : undefined,
          guidance: capital !== null
            ? `Available capital: ${capital}. targetSize for submit_decision is in base units — the amount of the asset being bought or sold, not a dollar value. A typical position size is 5–10% of capital; adjust up or down based on conviction and risk limits.`
            : 'Capital information unavailable. targetSize for submit_decision is in base units — the amount of the asset being bought or sold. You must provide a value; a conservative starting point is 5% of your expected capital.',
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      return {
        success: false,
        fault: false,
        error: `Failed to get account summary: ${message}`,
        errorCode: 'account.summary_failed',
      };
    }
  },
};

export const accountTools: AgentTool[] = [getAccountSummaryTool];
