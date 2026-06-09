import { z } from 'zod';
import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { AGENT_MESSAGE_TYPES } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';

// --- submit_decision ---

const SubmitDecisionParamsSchema = z.object({
  instrumentId: z.string().min(1),
  intent: z.enum(['go_long', 'go_short', 'go_flat', 'increase', 'decrease']),
  targetSize: z.string().regex(/^\d+(\.\d+)?$/, 'Must be a decimal string'),
  limitPrice: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  rationaleSummary: z.string().min(1),
  confidence: z.number().min(0).max(1).optional(),
});

const submitDecisionTool: AgentTool = {
  name: 'submit_decision',
  description: 'Submit a trade decision for a specific instrument. The decision will be evaluated by the risk gate and executed if approved. Use this to express trading intent based on your analysis.',
  parametersSchema: SubmitDecisionParamsSchema,
  parameters: convertZodToJsonSchema(SubmitDecisionParamsSchema),
  category: 'execute-trade',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const p = params as z.infer<typeof SubmitDecisionParamsSchema>;

    if (ctx.sessionMetrics) {
      ctx.sessionMetrics.decisionsSubmitted++;
    }

    const crypto = await import('node:crypto');
    const decisionId = crypto.randomUUID();

    await ctx.publishToInbound(AGENT_MESSAGE_TYPES.DECISION_SUBMIT, {
      decisionId,
      instrumentId: p.instrumentId,
      intent: p.intent,
      targetSize: p.targetSize,
      limitPrice: p.limitPrice,
      rationaleSummary: p.rationaleSummary,
      confidence: p.confidence,
    });

    return {
      success: true,
      data: { ok: true, decisionId, note: 'decision submitted to engine' },
    };
  },
};

// --- create_bot ---

const CreateBotParamsSchema = z.object({
  venueAccountId: z.string().min(1).optional(),
  config: z.record(z.unknown()).optional(),
  rationale: z.string().max(500).optional(),
});

const createBotTool: AgentTool = {
  name: 'create_bot',
  description: 'Create and start a new trading bot. The bot will run independently with its own strategy and risk parameters. Use when you want to delegate a trading opportunity to an automated bot.',
  parametersSchema: CreateBotParamsSchema,
  parameters: convertZodToJsonSchema(CreateBotParamsSchema),
  category: 'execute-trade',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { venueAccountId, config, rationale } = params as z.infer<typeof CreateBotParamsSchema>;

    await ctx.publishToInbound(AGENT_MESSAGE_TYPES.MANAGE_BOT, {
      action: 'create_and_start',
      venueAccountId,
      config,
      rationale,
    });

    return {
      success: true,
      data: { ok: true, note: 'bot creation submitted — you will see it in the bot list on the next tick' },
    };
  },
};

export const tradingTools: AgentTool[] = [
  submitDecisionTool,
  createBotTool,
];
