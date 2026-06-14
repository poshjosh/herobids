/**
 * Actor health snapshot — describes the runtime health of a trading actor
 * as observed by the worker. Published to Redis for the API to read.
 */
export interface ActorHealthSnapshot {
  actorType: 'agent' | 'bot';
  actorId: string;
  status: 'starting' | 'healthy' | 'degraded' | 'paused' | 'recovery' | 'crashed' | 'stopped';
  reasons: string[];
  executionMode: 'paper' | 'shadow' | 'live';
  updatedAt: string;
  lastDecisionAt?: string;
  lastVenueSuccessAt?: string;
  lastVenueErrorAt?: string;
  streamState?: 'connected' | 'disconnected' | 'not_applicable';
  reconciliationState?: 'healthy' | 'degraded' | 'not_applicable';
  pendingLiveWorkCount?: number;
  lastDecisionFailureId?: string;
}

/** Redis key pattern for actor health snapshots */
export function actorHealthKey(actorType: 'agent' | 'bot', actorId: string): string {
  return `herobids:actor-health:${actorType}:${actorId}`;
}

/** TTL for health snapshots in Redis (seconds). Stale snapshots auto-expire. */
export const ACTOR_HEALTH_TTL_SECONDS = 120;
