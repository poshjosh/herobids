/**
 * Server health snapshot — describes the runtime health of a server process
 * as self-reported to Redis. Consumed by the admin dashboard to display
 * per-server resource utilisation across the fleet.
 *
 * Follows the same pattern as {@link ActorHealthSnapshot} for actor-level health.
 */

export const SERVER_TYPES = ['control-plane', 'agent-server', 'browser-pool', 'trading'] as const;
export type ServerType = typeof SERVER_TYPES[number];

export interface ServerHealthSnapshot {
  serverType: ServerType;
  serverId: string;
  hostname: string;
  memory: { totalBytes: number; usedBytes: number; freeBytes: number };
  disk: { totalBytes: number; usedBytes: number; freeBytes: number } | null;
  cpuPct: number | null;
  loadAvg: [number, number, number];
  uptimeSeconds: number;
  version: string;
  updatedAt: string; // ISO 8601
  metadata: Record<string, unknown>;
}

/** Redis key for a specific server's health snapshot. */
export function serverHealthKey(serverType: ServerType, serverId: string): string {
  return `herobids:server-health:${serverType}:${serverId}`;
}

/** SCAN pattern matching all server health keys. */
export function serverHealthKeyPattern(): string {
  return 'herobids:server-health:*';
}

/** TTL for server health snapshots in Redis (seconds). Stale snapshots auto-expire. */
export const SERVER_HEALTH_TTL_SECONDS = 60;

/** Publish interval in milliseconds. A server that misses ~4 heartbeats disappears. */
export const SERVER_HEALTH_PUBLISH_INTERVAL_MS = 15_000;
