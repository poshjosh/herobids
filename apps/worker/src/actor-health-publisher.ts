import type Redis from 'ioredis';
import type { ActorHealthSnapshot } from '@herobids/domain';
import { actorHealthKey, ACTOR_HEALTH_TTL_SECONDS } from '@herobids/domain';
import pino from 'pino';

const logger = pino({ name: 'actor-health-publisher' });

/**
 * Publishes actor health snapshots to Redis.
 * The API reads these to serve operator health queries.
 */
export class ActorHealthPublisher {
  constructor(private readonly redis: Redis) {}

  async publish(snapshot: ActorHealthSnapshot): Promise<void> {
    const key = actorHealthKey(snapshot.actorType, snapshot.actorId);
    try {
      await this.redis.set(key, JSON.stringify(snapshot), 'EX', ACTOR_HEALTH_TTL_SECONDS);
    } catch (err) {
      logger.error({ err, key }, 'Failed to publish actor health snapshot');
    }
  }

  async remove(actorType: 'agent' | 'bot', actorId: string): Promise<void> {
    const key = actorHealthKey(actorType, actorId);
    try {
      await this.redis.del(key);
    } catch (err) {
      logger.error({ err, key }, 'Failed to remove actor health snapshot');
    }
  }

  async get(actorType: 'agent' | 'bot', actorId: string): Promise<ActorHealthSnapshot | null> {
    const key = actorHealthKey(actorType, actorId);
    try {
      const raw = await this.redis.get(key);
      if (!raw) return null;
      return JSON.parse(raw) as ActorHealthSnapshot;
    } catch (err) {
      logger.error({ err, key }, 'Failed to read actor health snapshot');
      return null;
    }
  }
}
