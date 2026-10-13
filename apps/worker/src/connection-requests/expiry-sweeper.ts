import type { Redis } from 'ioredis';
import { ConnectionRequestRecordSchema, type AgentWakePayload } from '@herobids/domain';
import type { InstanceEventPublisher } from '../agents/instance-event-publisher.js';
import { createLogger } from '../logger.js';

const logger = createLogger('connection-request-expiry');

/** Sorted set of pending request ids scored by expiresAt epoch ms (written by the broker, A3). */
const PENDING_SORTED_SET = 'connection-requests:pending';

/**
 * Expires pending connection requests whose link has passed its expiry, waking
 * each requesting agent once with reason `expired`. Runs under the reminder
 * coordinator lease (D-A2). Returns the number of requests expired.
 */
export async function sweepExpiredConnectionRequests(
  redis: Redis,
  eventPublisher: InstanceEventPublisher,
  nowMs: number,
): Promise<number> {
  const dueIds = await redis.zrangebyscore(PENDING_SORTED_SET, '-inf', nowMs);
  let expired = 0;

  for (const requestId of dueIds) {
    const key = `connection-request:${requestId}`;
    const raw = await redis.get(key);
    const parsed = raw ? ConnectionRequestRecordSchema.safeParse(JSON.parse(raw)) : null;

    if (!parsed?.success) {
      // Record already gone (TTL) or unreadable: nothing to wake, drop the entry.
      logger.warn({ requestId }, 'Expired connection request has no readable record; dropping');
      await redis.zrem(PENDING_SORTED_SET, requestId);
      continue;
    }

    const record = parsed.data;
    if (record.status !== 'pending') {
      await redis.zrem(PENDING_SORTED_SET, requestId);
      continue;
    }

    const payload: AgentWakePayload = {
      wakeId: requestId,
      reason: `Connection request for ${record.provider} expired`,
      eventIds: [requestId],
      priority: 'normal',
      requestedAt: new Date(nowMs).toISOString(),
      source: 'connection',
      context: { requestId, provider: record.provider, reason: 'expired' },
    };
    try {
      await eventPublisher.emitAgentWake(record.agentId, payload);
    } catch (err) {
      // Leave the request pending so the next sweep retries the wake.
      logger.error({ err, requestId, agentId: record.agentId }, 'Failed to publish expiry wake; will retry');
      continue;
    }

    const ttl = await redis.ttl(key);
    await redis.set(key, JSON.stringify({ ...record, status: 'expired' }));
    if (ttl > 0) await redis.expire(key, ttl);
    await redis.del(`connection-request:pending:${record.agentId}:${record.provider}`);
    await redis.srem(`connection-request:pending-agent:${record.agentId}`, record.provider);
    await redis.zrem(PENDING_SORTED_SET, requestId);
    expired += 1;
  }

  return expired;
}
