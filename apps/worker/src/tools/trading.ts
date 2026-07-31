import { z } from 'zod';
import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { AGENT_MESSAGE_TYPES } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';

// --- submit_decision ---

const SubmitDecisionParamsSchema = z.object({
  instrumentId: z.string().min(1).describe('Venue-specific instrument identifier. Use base tickers for perpetuals venues (e.g. "BTC", "SOL") and pair symbols for swap venues (e.g. "SOL/USDC").'),
  intent: z.enum(['go_long', 'go_short', 'go_flat', 'increase', 'decrease']).describe('Trading intent: go_long, go_short, go_flat (close), increase, or decrease position'),
  targetSize: z.string().regex(/^\d+(\.\d+)?$/, 'Must be a decimal string').describe('Target position size in BASE units as a decimal string — the amount of the traded asset, not a dollar value. For ETH/USDC this means ETH (e.g. "0.0064"), not USDC.'),
  limitPrice: z.string().regex(/^\d+(\.\d+)?$/).optional().transform(v => v === '' ? undefined : v).describe('Optional limit price as a decimal string. Omit to execute at market.'),
  rationaleSummary: z.string().min(1).max(400).describe('Brief explanation of why this trade is being taken'),
  confidence: z.number().min(0).max(1).optional().describe('Confidence level 0-1. Used for position sizing hints.'),
  safetyOverrideId: z.string().optional().transform(v => v === '' ? undefined : v).describe('One-time code to override a previous safety rejection. Only provide the exact code from a prior rejection response.'),
  dryRun: z.boolean().optional().describe('If true, validates the decision without submitting it. Returns a preview of what would be sent to the engine.'),
  stopLoss: z.string().regex(/^\d+(\.\d+)?$/).optional().transform(v => v === '' ? undefined : v).describe('In-process stop-loss level monitored while the runtime is alive. Active-session protection only — does not fire during a full worker crash. Set via submit_decision on position-open or increase.'),
  takeProfit: z.string().regex(/^\d+(\.\d+)?$/).optional().transform(v => v === '' ? undefined : v).describe('In-process take-profit level monitored while the runtime is alive. Active-session protection only — does not fire during a full worker crash. Set via submit_decision on position-open or increase.'),
});

const submitDecisionTool: AgentTool = {
  name: 'submit_decision',
  description: 'Submit a trade decision for a specific instrument. In direct authorization mode, accepted decisions proceed to execution immediately. In approval_required mode, the decision is recorded and sent to the user for approval — no trade executes until the user responds with /yes <code> or /no <code>. Check your runtime context for the active authorization mode.',
  parametersSchema: SubmitDecisionParamsSchema,
  parameters: convertZodToJsonSchema(SubmitDecisionParamsSchema),
  category: 'execute-trade',
  promptGuidance: 'Use dryRun=true first to preview the decision before submitting. Call find_instrument to get the correct instrumentId, and get_account_summary to see available capital and open positions. targetSize is denominated in the base asset (e.g. ETH in ETH/USDC), so a $50 position at $2500/ETH is "0.02". Use get_schema("venue-defaults") for recommended slippage values. In approval_required mode, your decision will be recorded and sent to the user — ask them to approve with /yes <code> or reject with /no <code>. No trade executes without user approval.',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const p = params as z.infer<typeof SubmitDecisionParamsSchema>;

    if (ctx.sessionMetrics) {
      ctx.sessionMetrics.decisionsSubmitted++;
    }

    // Dry-run: validate and preview without submitting.
    // Schema-level validation (shape, types, required fields) has already run
    // via Zod in executeTool(). Risk-gate validation happens at publish time.
    if (p.dryRun) {
      return {
        success: true,
        data: {
          ok: true,
          dryRun: true,
          preview: {
            instrumentId: p.instrumentId,
            intent: p.intent,
            targetSize: p.targetSize,
            limitPrice: p.limitPrice ?? 'market',
            stopLoss: p.stopLoss ?? 'not set',
            takeProfit: p.takeProfit ?? 'not set',
            rationaleSummary: p.rationaleSummary,
            confidence: p.confidence ?? null,
          },
          note: 'Dry run — schema-level validation passed. NOT submitted. Risk-gate validation (limits, position caps, circuit breaker) runs at submission time. Remove dryRun=true to execute.',
        },
      };
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
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
      rationaleSummary: p.rationaleSummary,
      confidence: p.confidence,
      safetyOverrideId: p.safetyOverrideId,
      dryRun: p.dryRun,
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
    let parsed: { status: string; code?: string; message?: string; planId?: string; approvalId?: string; shortCode?: string; expiresAt?: string };
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
          note: parsed.message ?? 'Decision accepted by engine and sent for execution.',
        },
      };
    }

    if (parsed.status === 'pending_approval') {
      return {
        success: true,
        data: {
          ok: true,
          status: 'pending_approval',
          approvalId: parsed.approvalId,
          shortCode: parsed.shortCode,
          expiresAt: parsed.expiresAt,
          note: parsed.message ?? `Decision recorded and sent to the user for approval. No trade has been executed yet. Ask the user to approve with /yes ${parsed.shortCode ?? '<code>'} or reject with /no ${parsed.shortCode ?? '<code>'}.`,
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
