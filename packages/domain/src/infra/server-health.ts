/**
 * Server health snapshot — describes the runtime health of a server process
 * as self-reported to Redis. Consumed by the admin dashboard to display
 * per-server resource utilisation across the fleet.
 */

import { z } from 'zod';

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

/** Redis key for the cluster agent-capacity snapshot (single key; last writer wins). */
export const CLUSTER_CAPACITY_KEY = 'herobids:cluster-capacity';

/**
 * Cluster agent-capacity snapshot written by the worker and read by the admin API.
 * Mirrors the autoscaler's capacity figures. `maxAgentNodes` is operator-configured and
 * shown for reference; the real scale-out ceiling is enforced by infrastructure.
 *
 * The schema is the validation boundary: the API `safeParse`s the Redis value before
 * returning it, so a malformed or wrong-shaped snapshot reads as "not reporting" rather
 * than rendering `undefined`/`NaN` in the UI. The type is inferred so the two cannot drift.
 */
export const ClusterCapacitySnapshotSchema = z.object({
  readyAgentNodes: z.number(),
  maxAgentNodes: z.number(),
  freeSlots: z.number(),
  freeMemoryMb: z.number(),
  totalMemoryMb: z.number(),
  agentMemoryReservationMb: z.number(),
  agentCpuReservationMhz: z.number(),
  updatedAt: z.string(),
});

export type ClusterCapacitySnapshot = z.infer<typeof ClusterCapacitySnapshotSchema>;

/** Publish interval in milliseconds. A server that misses ~4 heartbeats disappears. */
export const SERVER_HEALTH_PUBLISH_INTERVAL_MS = 15_000;
