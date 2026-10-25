import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentTool, ToolContext, ToolResult } from '@herobids/domain';
import { AGENT_MESSAGE_TYPES, PEER_ERROR_CODES, PeerSendResultSchema } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';
import { parseBrokerDenialReply } from './tool-errors.js';

/** Longer than the broker's 15 s capability timeout, so a broker refusal arrives before the tool gives up. */
const PEER_SEND_REPLY_TIMEOUT_S = 20;

export const MESSAGE_PEER_AGENT_TOOL_NAME = 'message_peer_agent';

/** Refusals that may succeed on a later attempt without changing the message. */
const RETRYABLE_CODES: readonly string[] = [
  PEER_ERROR_CODES.rateLimited,
  PEER_ERROR_CODES.unavailable,
  PEER_ERROR_CODES.deliveryFailed,
];

// Strict: the sender is always the calling agent, never named by input. The platform decides who may be messaged.
const MessagePeerAgentParamsSchema = z.object({
  agent: z.string().trim().min(1).max(200).describe('The id or exact name of another agent of the same user'),
  message: z.string().min(1).describe('The message to send to the other agent'),
}).strict();

export const messagePeerAgentTool: AgentTool = {
  name: MESSAGE_PEER_AGENT_TOOL_NAME,
  description: 'Send a message to another agent that belongs to the same user. The recipient wakes and reads it. Messages are rate limited per user, and the user can pause agent-to-agent messaging. If the recipient is not found, the error lists your other agents.',
  parametersSchema: MessagePeerAgentParamsSchema,
  parameters: convertZodToJsonSchema(MessagePeerAgentParamsSchema),
  category: 'write-messaging',
  promptGuidance: 'A message from another agent is tagged [PEER ...] in your context. Reply to that agent with message_peer_agent, and to your user with send_message.',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const parsed = MessagePeerAgentParamsSchema.safeParse(params);
    if (!parsed.success) {
      return { success: false, error: parsed.error.issues[0]?.message ?? 'Invalid message_peer_agent parameters', errorCode: 'validation.invalid_payload', fault: false };
    }

    if (!ctx.publishToInbound || typeof ctx.redis.blpop !== 'function') {
      return { success: false, error: 'Broker communication not available in this context', errorCode: 'peer.broker_unavailable', fault: false };
    }

    const requestMessageId = randomUUID();
    await ctx.publishToInbound(
      AGENT_MESSAGE_TYPES.PEER_SEND,
      { agent: parsed.data.agent, message: parsed.data.message, requestMessageId } as Record<string, unknown>,
    );

    const reply = await ctx.redis.blpop(`agent:peer-send:reply:${requestMessageId}`, PEER_SEND_REPLY_TIMEOUT_S);
    if (!reply) {
      return { success: false, retryable: true, error: 'Timed out waiting for broker reply', errorCode: 'broker.timeout', fault: false };
    }

    let replyData: unknown;
    try {
      replyData = JSON.parse(reply[1]);
    } catch {
      return { success: false, error: 'Received malformed reply from broker', errorCode: 'broker.malformed_reply', fault: false };
    }
    if (typeof replyData === 'object' && replyData !== null) {
      const denial = parseBrokerDenialReply(replyData as Record<string, unknown>);
      if (denial) return denial;
    }

    const result = PeerSendResultSchema.safeParse(replyData);
    if (!result.success) {
      return { success: false, error: 'Received malformed reply from broker', errorCode: 'broker.malformed_reply', fault: false };
    }
    if (result.data.status === 'error') {
      return {
        success: false,
        error: result.data.error,
        errorCode: result.data.errorCode,
        retryable: RETRYABLE_CODES.includes(result.data.errorCode),
        fault: false,
        ...(result.data.peers ? { data: { peers: result.data.peers } } : {}),
      };
    }
    return {
      success: true,
      data: {
        ok: true,
        agentId: result.data.recipientAgentId,
        agentName: result.data.recipientName,
        note: 'Message delivered. The recipient reads it on its next run; a reply, if any, arrives as a message from that agent.',
      },
    };
  },
};
