import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentTool, ToolContext, ToolResult } from '@herobids/domain';
import { AGENT_MESSAGE_TYPES, UpdatePromptResultSchema } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';
import { parseBrokerDenialReply } from './tool-errors.js';

const UPDATE_PROMPT_REPLY_TIMEOUT_S = 15;

const UpdateMyPromptParamsSchema = z.object({
  prompt: z.string().min(1, 'prompt must not be empty').max(8000, 'prompt must be at most 8000 characters'),
});

export const updateMyPromptTool: AgentTool = {
  name: 'update_my_prompt',
  description: "Replace this agent's standing goal (prompt) with the text given. Use only when the user asks to change what you are for.",
  parametersSchema: UpdateMyPromptParamsSchema,
  parameters: convertZodToJsonSchema(UpdateMyPromptParamsSchema),
  category: 'write-database',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const parsed = UpdateMyPromptParamsSchema.safeParse(params);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid prompt', errorCode: 'validation.invalid_payload', fault: false };
    }

    if (!ctx.publishToInbound || typeof ctx.redis.blpop !== 'function') {
      return { success: false, error: 'Broker communication not available in this context', errorCode: 'prompt.broker_unavailable', fault: false };
    }

    const requestMessageId = randomUUID();
    await ctx.publishToInbound(
      AGENT_MESSAGE_TYPES.UPDATE_PROMPT,
      { prompt: parsed.data.prompt, requestMessageId } as Record<string, unknown>,
    );

    const reply = await ctx.redis.blpop(`agent:update-prompt:reply:${requestMessageId}`, UPDATE_PROMPT_REPLY_TIMEOUT_S);
    if (!reply) {
      return { success: false, retryable: true, error: 'Timed out waiting for broker reply', errorCode: 'broker.timeout', fault: false };
    }

    const replyData = JSON.parse(reply[1]) as Record<string, unknown>;
    const denialResult = parseBrokerDenialReply(replyData);
    if (denialResult) return denialResult;

    const parsedReply = UpdatePromptResultSchema.safeParse(replyData);
    if (!parsedReply.success) {
      return { success: false, error: 'Received malformed reply from broker', errorCode: 'broker.malformed_reply', fault: false };
    }

    const result = parsedReply.data;
    if (result.status === 'error') {
      return { success: false, error: result.error, errorCode: result.errorCode, fault: false };
    }
    return { success: true, data: { ok: true, promptLength: result.promptLength, guidance: 'The new goal applies from your next run.' } };
  },
};
