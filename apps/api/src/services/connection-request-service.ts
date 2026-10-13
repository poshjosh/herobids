import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import {
  AGENT_STREAM_MAXLEN,
  ConnectionRequestRecordSchema,
  MARKET_MONITOR_MESSAGE_TYPES,
  err,
  ok,
  type AgentWakePayload,
  type AgentWakePublisher,
  type ConnectionRequestRecord,
  type ConnectionWakeContext,
  type Result,
} from '@herobids/domain';
import type { Database } from '@herobids/db';
import type { TradingProfileReconciliationSaga } from '../agents/trading-profile-reconciliation-saga.js';
import { grantConnectionToRunningAgent } from './agent-config-service.js';
import { createLogger } from '../logger.js';

const logger = createLogger('connection-request-service');

/** Redis key for a pending connection-request record (written by the worker broker). */
export function connectionRequestKey(requestId: string): string {
  return `connection-request:${requestId}`;
}

/** Redis key marking a request's link as redeemed (single-use guard). */
function connectionRedeemedKey(requestId: string): string {
  return `connection-request:redeemed:${requestId}`;
}

/** Redis key for the per-agent pending-provider SET (mirrors the broker's A3 keys). */
function pendingAgentSetKey(agentId: string): string {
  return `connection-request:pending-agent:${agentId}`;
}

/** Redis key for the per-agent-per-provider pending lock (mirrors the broker's A3 keys). */
function pendingProviderKey(agentId: string, provider: string): string {
  return `connection-request:pending:${agentId}:${provider}`;
}

/** The pending sorted set scored by expiresAt epoch ms (mirrors the broker's A3 key). */
const PENDING_SORTED_SET = 'connection-requests:pending';

/**
 * Read a connection-request record by its bearer token (for the redeem
 * endpoint). Returns the record or null when the token is unknown/expired.
 * Does NOT consume the token — the caller deletes it after issuing a session.
 */
export async function readConnectionRequestByToken(
  redis: Redis,
  token: string,
): Promise<ConnectionRequestRecord | null> {
  // The record is keyed by requestId, not token. To look up by token we scan
  // the pending sorted set members and read each record until the token matches.
  // Pending requests are few (bounded by maxPendingPerAgent), so a scan is cheap.
  const requestIds = await redis.zrange(PENDING_SORTED_SET, 0, -1);
  for (const requestId of requestIds) {
    const raw = await redis.get(connectionRequestKey(requestId));
    if (!raw) continue;
    const parsed = ConnectionRequestRecordSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) continue;
    if (parsed.data.token === token) return parsed.data;
  }
  return null;
}

/**
 * Read a connection-request record by requestId. Returns null when absent.
 */
export async function readConnectionRequest(
  redis: Redis,
  requestId: string,
): Promise<ConnectionRequestRecord | null> {
  const raw = await redis.get(connectionRequestKey(requestId));
  if (!raw) return null;
  const parsed = ConnectionRequestRecordSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}

/** Marks a request's link as redeemed (single-use). The record stays pending until completed, declined or expired. */
export async function markConnectionRequestRedeemed(redis: Redis, requestId: string): Promise<void> {
  const ttl = await redis.ttl(connectionRequestKey(requestId));
  if (ttl <= 0) return;
  await redis.set(connectionRedeemedKey(requestId), '1', 'EX', ttl);
}

export async function isConnectionRequestRedeemed(redis: Redis, requestId: string): Promise<boolean> {
  return (await redis.exists(connectionRedeemedKey(requestId))) === 1;
}

/**
 * Release the pending state for a request (per-provider lock + per-agent SET
 * membership + sorted-set entry). Idempotent — safe to call on any terminal
 * transition (completed/declined/expired).
 */
export async function releaseConnectionRequestPendingState(
  redis: Redis,
  record: ConnectionRequestRecord,
): Promise<void> {
  await redis.del(pendingProviderKey(record.agentId, record.provider));
  await redis.srem(pendingAgentSetKey(record.agentId), record.provider);
  await redis.zrem(PENDING_SORTED_SET, record.requestId);
}

/**
 * Mark a request terminal (completed/declined/expired) and release its pending
 * state. The record itself is left to expire via its TTL (it carries the
 * terminal status for observability).
 */
export async function finalizeConnectionRequest(
  redis: Redis,
  record: ConnectionRequestRecord,
  status: 'completed' | 'declined' | 'expired',
): Promise<void> {
  const updated: ConnectionRequestRecord = { ...record, status };
  // Preserve the remaining TTL so the terminal record still expires.
  const ttl = await redis.ttl(connectionRequestKey(record.requestId));
  await redis.set(connectionRequestKey(record.requestId), JSON.stringify(updated));
  if (ttl > 0) await redis.expire(connectionRequestKey(record.requestId), ttl);
  await releaseConnectionRequestPendingState(redis, record);
}

/** API-side implementation of the `AgentWakePublisher` port (same XADD as the worker's publisher). */
export function createRedisAgentWakePublisher(redis: Redis): AgentWakePublisher {
  return {
    async emitAgentWake(agentId, payload) {
      const envelope = {
        schemaVersion: 'v1',
        messageId: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
        initiatorType: 'system',
        initiatorId: agentId,
        agentId,
        type: MARKET_MONITOR_MESSAGE_TYPES.AGENT_WAKE,
        createdAt: new Date().toISOString(),
        payload,
      };
      await redis.xadd(
        `agent:outbound:${agentId}`,
        'MAXLEN', '~', AGENT_STREAM_MAXLEN,
        '*',
        'envelope',
        JSON.stringify(envelope),
      );
    },
  };
}

export function buildConnectionWakePayload(context: ConnectionWakeContext): AgentWakePayload {
  const subject = context.reason === 'completed'
    ? `Connection request for ${context.provider} completed`
    : context.reason === 'declined'
      ? `Connection request for ${context.provider} was declined`
      : `Connection request for ${context.provider} expired`;
  return {
    wakeId: crypto.randomUUID(),
    reason: subject,
    eventIds: [context.requestId],
    priority: 'normal',
    requestedAt: new Date().toISOString(),
    source: 'connection',
    context,
  };
}

export interface ConnectionRequestDeps {
  redis: Redis;
  db: Database;
  saga: TradingProfileReconciliationSaga;
  wakePublisher: AgentWakePublisher;
}

export type ConnectionRequestOutcomeError = { code: string; message: string };

/**
 * Completes a pending request once its connection exists: grants the connection
 * to the requesting agent (running-agent path), finalizes the record, and wakes
 * the agent. On a grant failure the request stays pending for the expiry sweeper.
 */
export async function completeConnectionRequest(
  deps: ConnectionRequestDeps,
  input: { requestId: string; userId: string; provider: string; connectionId: string },
): Promise<Result<{ agentId: string }, ConnectionRequestOutcomeError>> {
  const record = await readConnectionRequest(deps.redis, input.requestId);
  if (!record || record.userId !== input.userId) {
    return err({ code: 'connection.request_not_found', message: 'Connection request not found' });
  }
  if (record.status !== 'pending') {
    return err({ code: 'connection.request_not_pending', message: `Connection request is ${record.status}` });
  }
  if (record.provider !== input.provider) {
    return err({ code: 'connection.request_provider_mismatch', message: `Connection request is for ${record.provider}` });
  }

  const granted = await grantConnectionToRunningAgent(deps.db, record.agentId, input.connectionId, input.userId, deps.saga);
  if (!granted.ok) {
    logger.error({ requestId: record.requestId, code: granted.error.code }, 'Grant for completed connection request failed');
    return err({ code: granted.error.code, message: granted.error.message });
  }

  await finalizeConnectionRequest(deps.redis, record, 'completed');
  await deps.wakePublisher.emitAgentWake(record.agentId, buildConnectionWakePayload({
    requestId: record.requestId,
    provider: record.provider,
    connectionId: input.connectionId,
    reason: 'completed',
  }));
  return ok({ agentId: record.agentId });
}

/** Declines a pending request the user cancelled, and wakes the agent with reason `declined`. */
export async function declineConnectionRequest(
  deps: Pick<ConnectionRequestDeps, 'redis' | 'wakePublisher'>,
  input: { requestId: string; userId: string },
): Promise<Result<{ agentId: string }, ConnectionRequestOutcomeError>> {
  const record = await readConnectionRequest(deps.redis, input.requestId);
  if (!record || record.userId !== input.userId) {
    return err({ code: 'connection.request_not_found', message: 'Connection request not found' });
  }
  if (record.status !== 'pending') {
    return err({ code: 'connection.request_not_pending', message: `Connection request is ${record.status}` });
  }

  await finalizeConnectionRequest(deps.redis, record, 'declined');
  await deps.wakePublisher.emitAgentWake(record.agentId, buildConnectionWakePayload({
    requestId: record.requestId,
    provider: record.provider,
    reason: 'declined',
  }));
  return ok({ agentId: record.agentId });
}