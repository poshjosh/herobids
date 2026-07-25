import type { Redis } from 'ioredis';
import { createLogger } from '../logger.js';

const logger = createLogger('agent-ephemeral-redis-cleanup');

/**
 * Best-effort deletion of an agent's ephemeral runtime Redis keys.
 * Idempotent (DEL ignores missing keys). Never throws — errors are logged.
 *
 * Does NOT touch the ref-counted session projection (`agent:sessions:*`),
 * nor durable product state (memory / tasks / reminders / watches).
 *
 * Deleted keys:
 *   agent:inbound:<agentId>
 *   agent:outbound:<agentId>
 *   agent:prompt:<agentId>
 *   agent:prompt:scout:<agentId>
 *   agent:prompt:user-context:<agentId>
 *   agent:prompt:judge-user-context:<agentId>
 *   agent:prompt:hybrid:<agentId>
 *   agent:scanner:fingerprint:<agentId>
 *   agent:scanner_gated:<agentId>
 *   agent:watches:summary:<agentId>
 *   herobids:actor-health:agent:<agentId>
 */
export async function cleanupEphemeralAgentRedisState(
  redis: Redis,
  agentId: string,
): Promise<void> {
  const keys = [
    `agent:inbound:${agentId}`,
    `agent:outbound:${agentId}`,
    `agent:prompt:${agentId}`,
    `agent:prompt:scout:${agentId}`,
    `agent:prompt:user-context:${agentId}`,
    `agent:prompt:judge-user-context:${agentId}`,
    `agent:prompt:hybrid:${agentId}`,
    `agent:scanner:fingerprint:${agentId}`,
    `agent:scanner_gated:${agentId}`,
    `agent:watches:summary:${agentId}`,
    `herobids:actor-health:agent:${agentId}`,
  ];

  try {
    const pipeline = redis.pipeline();
    for (const key of keys) {
      pipeline.del(key);
    }
    await pipeline.exec();
    logger.debug({ agentId, keyCount: keys.length }, 'Cleaned up ephemeral agent Redis state');
  } catch (err) {
    logger.warn({ err, agentId }, 'Failed to clean up ephemeral agent Redis state');
  }
}
