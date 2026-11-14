import {
  SERVER_HEALTH_PUBLISH_INTERVAL_MS,
  SERVER_HEALTH_TTL_SECONDS,
  serverHealthKey,
  type ServerHealthSnapshot,
} from '@herobids/domain';
import type { ServerHealthRedisClient, ServerHealthLogger } from '@herobids/domain';
import {
  countActiveAllocations,
  readAgentNodes,
  type AgentNodeSnapshot,
  type NomadClient,
} from './agents/index.js';
import { nodeFreeMemoryMb } from './cluster-capacity.js';

export interface AgentServerHealthPublisherOptions {
  redis: ServerHealthRedisClient;
  /** Present only when runtimeBackend is 'nomad'; the publisher no-ops otherwise. */
  nomadClient: NomadClient | undefined;
  /** Nomad Meta.node_pool to match ('' = no pool filter). */
  nodePool: string;
  logger: ServerHealthLogger;
  appVersion: string;
}

/**
 * Publishes one {@link ServerHealthSnapshot} per ready agent node to Redis, so the admin
 * dashboard's `agent-server` group shows per-node memory usage and the number of agent
 * allocations (containers) on each node. Reads come from Nomad via the shared
 * {@link readAgentNodes} helper (the single place the node/pool filter lives).
 *
 * No-op without a Nomad client (non-Nomad backend). Fail-soft: a cycle where the node
 * list or any per-node read fails is skipped (prior snapshots live out their TTL) rather
 * than publishing a misleading fleet. A single cycle guard prevents overlap.
 *
 * This is the single owner of the `agent-server` health snapshot. The legacy on-node
 * reporter (infra/hetzner/scripts/agent-node-health.sh + its systemd timer) writes the
 * same Redis key and is being retired — see
 * docs/features/pending/000-retire-agent-node-health-reporter/plan.md.
 */
export class AgentServerHealthPublisher {
  private readonly redis: ServerHealthRedisClient;
  private readonly nomadClient: NomadClient | undefined;
  private readonly nodePool: string;
  private readonly logger: ServerHealthLogger;
  private readonly appVersion: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  constructor(options: AgentServerHealthPublisherOptions) {
    this.redis = options.redis;
    this.nomadClient = options.nomadClient;
    this.nodePool = options.nodePool;
    this.logger = options.logger;
    this.appVersion = options.appVersion;
  }

  start(): void {
    if (!this.nomadClient) return;
    if (this.timer) return;

    void this.publishAll();
    this.timer = setInterval(() => void this.publishAll(), SERVER_HEALTH_PUBLISH_INTERVAL_MS);
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

  private async publishAll(): Promise<void> {
    const client = this.nomadClient;
    if (!client) return;
    // A slow Nomad loop can outlast the interval; skip overlapping ticks.
    if (this.inFlight) return;
    this.inFlight = true;

    try {
      const nodes = await readAgentNodes(client, this.nodePool);
      if (nodes === null) {
        this.logger.warn({}, 'Agent-server health: node reads unavailable; skipping this cycle');
        return;
      }
      await Promise.allSettled(nodes.map((node) => this.publishNode(node)));
    } catch (err: unknown) {
      this.logger.warn({ err }, 'Agent-server health publish cycle failed');
    } finally {
      this.inFlight = false;
    }
  }

  private async publishNode(node: AgentNodeSnapshot): Promise<void> {
    try {
      const snapshot = this.buildSnapshot(node);
      await this.redis.set(serverHealthKey('agent-server', snapshot.serverId), JSON.stringify(snapshot), 'EX', SERVER_HEALTH_TTL_SECONDS);
    } catch (err: unknown) {
      this.logger.warn({ err, nodeId: node.detail.ID }, 'Failed to publish agent-server health for node');
    }
  }

  private buildSnapshot(node: AgentNodeSnapshot): ServerHealthSnapshot {
    const { detail } = node;
    const serverId = detail.Name && detail.Name.length > 0 ? detail.Name : detail.ID;
    const totalMemoryMb = detail.NodeResources?.Memory?.MemoryMB ?? 0;
    const totalBytes = totalMemoryMb * 1_048_576;
    // Real free memory (total − reserved − occupying allocations), the same figure the
    // capacity publisher uses, so the card and the capacity section never disagree.
    const freeBytes = nodeFreeMemoryMb(node) * 1_048_576;
    const usedBytes = Math.max(totalBytes - freeBytes, 0);

    return {
      serverType: 'agent-server',
      serverId,
      hostname: serverId,
      memory: { totalBytes, usedBytes, freeBytes },
      disk: null,
      // Nomad does not expose live host CPU%; do not fabricate a value.
      cpuPct: null,
      loadAvg: [0, 0, 0],
      // Node uptime is not available from Nomad; 0 is a sentinel the dashboard hides for
      // agent-server rather than rendering "Up 0m".
      uptimeSeconds: 0,
      version: this.appVersion,
      updatedAt: new Date().toISOString(),
      metadata: {
        nomadAllocations: countActiveAllocations(node.allocations),
      },
    };
  }
}
