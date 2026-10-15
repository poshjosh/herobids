import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { AgentTool, ToolContext, ToolResult } from '@herobids/domain';
import {
  AGENT_MESSAGE_TYPES,
  ConnectionRequestResultSchema,
  getRuntimeFamiliesForProvider,
  PROVIDER_DISCOVERY,
} from '@herobids/domain';
import { agents, agentConnections, connections, type Database } from '@herobids/db';
import { convertZodToJsonSchema } from './registry.js';
import { parseBrokerDenialReply } from './tool-errors.js';
import { randomUUID } from 'node:crypto';

const CONNECTION_REQUEST_REPLY_TIMEOUT_S = 15;

const ListProvidersParamsSchema = z.object({ capability: z.enum(['trading', 'email']).optional() });

export interface ProviderConnectionState {
  provider: string;
  connectionId: string;
  granted: boolean;
}

export function projectProviders(
  rows: ProviderConnectionState[],
  capability: 'trading' | 'email' | undefined,
  hasTradingCapability: boolean,
  generatedWalletProviders: readonly string[] = [],
) {
  return Object.entries(PROVIDER_DISCOVERY).flatMap(([provider, definition]) => {
    const capabilities = getRuntimeFamiliesForProvider(provider);
    if (capability && !capabilities.includes(capability)) return [];
    if (!capability && capabilities.includes('trading') && !hasTradingCapability) return [];
    const matches = rows.filter((row) => row.provider === provider);
    return [{
      provider,
      displayName: definition.displayName,
      capabilities,
      authMethod: definition.authMethod === 'generated_wallet' && !generatedWalletProviders.includes(provider)
        ? 'api_key'
        : definition.authMethod,
      hasActiveConnection: matches.length > 0,
      grantedToThisAgent: matches.some((row) => row.granted),
    }];
  });
}

export const listProvidersTool: AgentTool = {
  name: 'list_providers',
  description: 'List available connection providers and whether the owner has an active connection or has granted one to this agent.',
  parametersSchema: ListProvidersParamsSchema,
  parameters: convertZodToJsonSchema(ListProvidersParamsSchema),
  category: 'read-database',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const parsed = ListProvidersParamsSchema.safeParse(params);
    if (!parsed.success) return { success: false, error: parsed.error.message, errorCode: 'validation.invalid_payload', fault: false };
    if (!ctx.db) return { success: false, error: 'connection catalog unavailable: database not configured', errorCode: 'precondition.not_ready', fault: false };

    try {
      const db = ctx.db as Database;
      const [owner] = await db.select({ userId: agents.userId }).from(agents).where(eq(agents.id, ctx.agentId)).limit(1);
      if (!owner) return { success: false, error: 'agent not found', errorCode: 'not_found.agent', fault: false };
      const rows = await db.select({
        provider: connections.provider,
        connectionId: connections.id,
        grantId: agentConnections.id,
      }).from(connections)
        .leftJoin(agentConnections, and(
          eq(agentConnections.connectionId, connections.id),
          eq(agentConnections.agentId, ctx.agentId),
          eq(agentConnections.status, 'active'),
        ))
        .where(and(eq(connections.userId, owner.userId), eq(connections.status, 'active')));
      return {
        success: true,
        data: { providers: projectProviders(
          rows.map((row) => ({ provider: row.provider, connectionId: row.connectionId, granted: row.grantId !== null })),
          parsed.data.capability,
          ctx.hasTradingCapability ?? false,
          ctx.generatedWalletProviders,
        ) },
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'provider lookup failed', errorCode: 'connection.lookup_failed', fault: true };
    }
  },
};

const RequestConnectionParamsSchema = z.object({
  provider: z.string().min(1),
});

export const requestConnectionTool: AgentTool = {
  name: 'request_connection',
  description: 'Request a connection to a provider. Returns a short-lived link to send to the user.',
  parametersSchema: RequestConnectionParamsSchema,
  parameters: convertZodToJsonSchema(RequestConnectionParamsSchema),
  category: 'write-database',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const parsed = RequestConnectionParamsSchema.safeParse(params);
    if (!parsed.success) {
      return {
        success: false,
        error: 'Invalid parameters: provider must be a non-empty string',
        errorCode: 'validation.invalid_payload',
        fault: false,
      };
    }
    const { provider } = parsed.data;

    if (!ctx.publishToInbound || typeof ctx.redis.blpop !== 'function') {
      return {
        success: false,
        error: 'Broker communication not available in this context',
        errorCode: 'connection.broker_unavailable',
        fault: false,
      };
    }

    const requestMessageId = randomUUID();

    await ctx.publishToInbound(
      AGENT_MESSAGE_TYPES.REQUEST_CONNECTION,
      { provider, requestMessageId } as Record<string, unknown>,
    );

    const reply = await ctx.redis.blpop(
      `agent:connection-request:reply:${requestMessageId}`,
      CONNECTION_REQUEST_REPLY_TIMEOUT_S,
    );

    if (!reply) {
      return {
        success: false,
        retryable: true,
        error: 'Timed out waiting for broker reply',
        errorCode: 'broker.timeout',
        fault: false,
      };
    }

    const replyData = JSON.parse(reply[1]) as Record<string, unknown>;
    const denialResult = parseBrokerDenialReply(replyData);
    if (denialResult) return denialResult;

    const parsedReply = ConnectionRequestResultSchema.safeParse(replyData);
    if (!parsedReply.success) {
      return {
        success: false,
        error: 'Received malformed reply from broker',
        errorCode: 'broker.malformed_reply',
        fault: false,
      };
    }

    const result = parsedReply.data;

    if (result.status === 'error') {
      return {
        success: false,
        error: result.error,
        errorCode: result.errorCode,
        fault: false,
      };
    }

    return {
      success: true,
      data: {
        requestId: result.requestId,
        link: result.link,
        expiresAt: result.expiresAt,
      },
    };
  },
};