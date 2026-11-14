import {
  CLUSTER_CAPACITY_KEY,
  SERVER_HEALTH_PUBLISH_INTERVAL_MS,
  SERVER_HEALTH_TTL_SECONDS,
  type ClusterCapacitySnapshot,
} from '@herobids/domain';
import type { ServerHealthRedisClient, ServerHealthLogger } from '@herobids/domain';
import { readAgentNodes, type NomadClient } from './agents/index.js';
import { computeClusterCapacity } from './cluster-capacity.js';

export interface ClusterCapacityPublisherOptions {
  redis: ServerHealthRedisClient;
  /** Present only when runtimeBackend is 'nomad'; the publisher no-ops otherwise. */
  nomadClient: NomadClient | undefined;
  /** Nomad Meta.node_pool to match ('' = no pool filter). */
  nodePool: string;
  /** MB reserved per agent slot (operator config, mirrors the autoscaler). */
  agentMemoryReservationMb: number;
  /** CPU (MHz) reserved per agent slot (operator config, mirrors the autoscaler). */
  agentCpuReservationMhz: number;
  /** Scale-out ceiling shown on the dashboard (operator config, mirrors the autoscaler). */
  maxAgentNodes: number;
  logger: ServerHealthLogger;
}

/**
 * Periodically computes cluster agent-capacity from Nomad and publishes a single
 * {@link ClusterCapacitySnapshot} to Redis for the admin dashboard. Reuses the shared
 * {@link readAgentNodes} helper and the pure {@link computeClusterCapacity} math.
 *
 * No-op without a Nomad client (non-Nomad backend). Fail-soft: a cycle where the node
 * list or any ready node's reads fail is skipped so a partial reading never understates
 * used memory (and so overstates free capacity); the prior snapshot lives out its TTL.
 * A single cycle guard prevents overlap.
 */
export class ClusterCapacityPublisher {
  private readonly redis: ServerHealthRedisClient;
  private readonly nomadClient: NomadClient | undefined;
  private readonly nodePool: string;
  private readonly agentMemoryReservationMb: number;
  private readonly agentCpuReservationMhz: number;
  private readonly maxAgentNodes: number;
  private readonly logger: ServerHealthLogger;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  constructor(options: ClusterCapacityPublisherOptions) {
    this.redis = options.redis;
    this.nomadClient = options.nomadClient;
    this.nodePool = options.nodePool;
    this.agentMemoryReservationMb = options.agentMemoryReservationMb;
    this.agentCpuReservationMhz = options.agentCpuReservationMhz;
    this.maxAgentNodes = options.maxAgentNodes;
    this.logger = options.logger;
  }

  start(): void {
    if (!this.nomadClient) return;
    if (this.timer) return;

    void this.publish();
    this.timer = setInterval(() => void this.publish(), SERVER_HEALTH_PUBLISH_INTERVAL_MS);
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async publish(): Promise<void> {
    const client = this.nomadClient;
    if (!client) return;
    if (this.inFlight) return;
    this.inFlight = true;

    try {
      const nodes = await readAgentNodes(client, this.nodePool);
      if (nodes === null) {
        this.logger.warn({}, 'Cluster capacity: node reads unavailable; skipping this cycle');
        return;
      }

      const capacity = computeClusterCapacity(
        nodes,
        { memoryMb: this.agentMemoryReservationMb, cpuMhz: this.agentCpuReservationMhz },
        this.maxAgentNodes,
      );
      const snapshot: ClusterCapacitySnapshot = { ...capacity, updatedAt: new Date().toISOString() };
      await this.redis.set(CLUSTER_CAPACITY_KEY, JSON.stringify(snapshot), 'EX', SERVER_HEALTH_TTL_SECONDS);
    } catch (err: unknown) {
      this.logger.warn({ err }, 'Cluster capacity publish cycle failed');
    } finally {
      this.inFlight = false;
    }
  }
}
