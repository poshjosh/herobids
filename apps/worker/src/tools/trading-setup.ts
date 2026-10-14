import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentTool, ToolContext, ToolResult } from '@herobids/domain';
import { AGENT_MESSAGE_TYPES, TradingSetupResultSchema } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';
import { parseBrokerDenialReply } from './tool-errors.js';

const TRADING_SETUP_REPLY_TIMEOUT_S = 30;

const SetTradingSetupParamsSchema = z.object({
  capital: z.string().regex(/^\d+(\.\d+)?$/, 'capital must be a decimal string').optional(),
});

export const setTradingSetupTool: AgentTool = {
  name: 'set_trading_setup',
  description: 'Set up paper trading for this agent: reuses or creates a test wallet, sets the capital, and grants it. Paper mode only; live mode is never set here. Returns the wallet address to fund and the capital.',
  parametersSchema: SetTradingSetupParamsSchema,
  parameters: convertZodToJsonSchema(SetTradingSetupParamsSchema),
  category: 'write-database',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const parsed = SetTradingSetupParamsSchema.safeParse(params);
    if (!parsed.success) {
      return {
        success: false,
        error: 'Invalid parameters: capital must be a decimal string',
        errorCode: 'validation.invalid_payload',
        fault: false,
      };
    }

    if (!ctx.publishToInbound || typeof ctx.redis.blpop !== 'function') {
      return {
        success: false,
        error: 'Broker communication not available in this context',
        errorCode: 'trading.broker_unavailable',
        fault: false,
      };
    }

    const requestMessageId = randomUUID();
    await ctx.publishToInbound(
      AGENT_MESSAGE_TYPES.MANAGE_TRADING_SETUP,
      { ...(parsed.data.capital ? { capital: parsed.data.capital } : {}), requestMessageId } as Record<string, unknown>,
    );

    const reply = await ctx.redis.blpop(`agent:trading-setup:reply:${requestMessageId}`, TRADING_SETUP_REPLY_TIMEOUT_S);
    if (!reply) {
      return { success: false, retryable: true, error: 'Timed out waiting for broker reply', errorCode: 'broker.timeout', fault: false };
    }

    const replyData = JSON.parse(reply[1]) as Record<string, unknown>;
    const denialResult = parseBrokerDenialReply(replyData);
    if (denialResult) return denialResult;

    const parsedReply = TradingSetupResultSchema.safeParse(replyData);
    if (!parsedReply.success) {
      return { success: false, error: 'Received malformed reply from broker', errorCode: 'broker.malformed_reply', fault: false };
    }

    const result = parsedReply.data;
    if (result.status === 'error') {
      return { success: false, error: result.error, errorCode: result.errorCode, fault: false };
    }

    return {
      success: true,
      data: {
        ok: true,
        connectionId: result.connectionId,
        provider: result.provider,
        network: result.network,
        capital: result.capital,
        mode: result.mode,
        reused: result.reused,
        walletAddress: result.walletAddress,
        guidance: result.walletAddress
          ? `Paper trading is set up. Tell the user to fund the wallet ${result.walletAddress} on ${result.network}; it stays unfunded until they send funds.`
          : `Paper trading is set up on ${result.network}. No balance has been observed yet.`,
      },
    };
  },
};
