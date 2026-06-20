import { z } from 'zod';
import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { AGENT_MESSAGE_TYPES } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';

// --- submit_decision ---

const SubmitDecisionParamsSchema = z.object({
  instrumentId: z.string().min(1).describe('Venue-specific instrument identifier. Use base tickers for perpetuals venues (e.g. "BTC", "SOL") and pair symbols for swap venues (e.g. "SOL/USDC").'),
  intent: z.enum(['go_long', 'go_short', 'go_flat', 'increase', 'decrease']).describe('Trading intent: go_long, go_short, go_flat (close), increase, or decrease position'),
  targetSize: z.string().regex(/^\d+(\.\d+)?$/, 'Must be a decimal string').describe('Target position size as a decimal string (e.g. "0.5", "100")'),
  limitPrice: z.string().regex(/^\d+(\.\d+)?$/).optional().transform(v => v === '' ? undefined : v).describe('Optional limit price as a decimal string. Omit to execute at market.'),
  rationaleSummary: z.string().min(1).describe('Brief explanation of why this trade is being taken'),
  confidence: z.number().min(0).max(1).optional().describe('Confidence level 0-1. Used for position sizing hints.'),
  safetyOverrideId: z.string().optional().transform(v => v === '' ? undefined : v).describe('One-time code to override a previous safety rejection. Only provide the exact code from a prior rejection response.'),
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
    const replyKey = `agent:decision:reply:${decisionId}`;

    await ctx.publishToInbound(AGENT_MESSAGE_TYPES.DECISION_SUBMIT, {
      decisionId,
      instrumentId: p.instrumentId,
      intent: p.intent,
      targetSize: p.targetSize,
      limitPrice: p.limitPrice,
      rationaleSummary: p.rationaleSummary,
      confidence: p.confidence,
      safetyOverrideId: p.safetyOverrideId,
      // Signal to the handler that this decision expects a synchronous reply
      _expectsReply: true,
    });

    // Await the engine's reply (accepted, rejected, or error).
    // Time out after 30s to avoid blocking the tick forever.
    const reply = await ctx.redis.blpop(replyKey, 30);
    if (!reply) {
      return {
        success: false,
        fault: false,
        error: 'Decision reply timed out after 30s — check the agent events stream for status.',
        errorCode: 'decision_reply_timeout',
      };
    }

    const [, raw] = reply;
    let parsed: { status: string; code?: string; message?: string; planId?: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        success: false,
        fault: false,
        error: 'Decision reply was malformed — the engine returned an unreadable response.',
        errorCode: 'decision_reply_malformed',
      };
    }

    if (parsed.status === 'accepted') {
      return {
        success: true,
        data: {
          ok: true,
          decisionId,
          planId: parsed.planId,
          note: 'Decision accepted by engine and sent for execution.',
        },
      };
    }

    if (parsed.status === 'rejected') {
      return {
        success: false,
        fault: false,
        error: parsed.message ?? 'Decision rejected by risk gate.',
        errorCode: parsed.code ?? 'risk.rejected',
        data: { decisionId },
      };
    }

    // Error during processing
    return {
      success: false,
      fault: false,
      error: parsed.message ?? 'Decision could not be processed.',
      errorCode: parsed.code ?? 'decision_processing_error',
      data: { decisionId },
    };
  },
};

export const tradingTools: AgentTool[] = [
  submitDecisionTool,
];
