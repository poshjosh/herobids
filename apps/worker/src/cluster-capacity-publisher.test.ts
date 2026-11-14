import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLUSTER_CAPACITY_KEY,
  SERVER_HEALTH_TTL_SECONDS,
  type ClusterCapacitySnapshot,
} from '@herobids/domain';
import type { ServerHealthRedisClient, ServerHealthLogger } from '@herobids/domain';
import {
  ClusterCapacityPublisher,
  type ClusterCapacityPublisherOptions,
} from './cluster-capacity-publisher.js';
import type { NomadClient, NomadNodeDetail, NomadNodeListEntry, NomadNodeAllocation } from './agents/index.js';

function mockRedis(): ServerHealthRedisClient & { set: ReturnType<typeof vi.fn> } {
  return { set: vi.fn().mockResolvedValue('OK') };
}

function mockLogger(): ServerHealthLogger & { warn: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn() };
}

interface Behavior {
  nodes: NomadNodeListEntry[] | null;
  nodeDetail?: (id: string) => NomadNodeDetail | null;
  nodeAllocations?: (id: string) => NomadNodeAllocation[] | null;
}

function mockNomadClient(behavior: Behavior): NomadClient {
  return {
    listNodes: vi.fn().mockResolvedValue(behavior.nodes),
    getNode: vi.fn(async (id: string) => (
      behavior.nodeDetail ? behavior.nodeDetail(id) : { ID: id, Name: id, NodeResources: { Memory: { MemoryMB: 1024 }, Cpu: { CpuShares: 100_000 } } }
    )),
    getNodeAllocations: vi.fn(async (id: string) => (
      behavior.nodeAllocations ? behavior.nodeAllocations(id) : []
    )),
  } as unknown as NomadClient;
}

const readyAgentNode = (id: string): NomadNodeListEntry => ({
  ID: id,
  Name: id,
  Status: 'ready',
  SchedulingEligibility: 'eligible',
  NodeClass: 'agent',
});

function createOptions(overrides: Partial<ClusterCapacityPublisherOptions> = {}): ClusterCapacityPublisherOptions {
  return {
    redis: mockRedis(),
    nomadClient: mockNomadClient({ nodes: [] }),
    nodePool: '',
    agentMemoryReservationMb: 256,
    agentCpuReservationMhz: 256,
    maxAgentNodes: 5,
    logger: mockLogger(),
    ...overrides,
  };
}

function snapshot(redis: { set: ReturnType<typeof vi.fn> }): ClusterCapacitySnapshot {
  return JSON.parse(redis.set.mock.calls[0]![1] as string) as ClusterCapacitySnapshot;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ClusterCapacityPublisher', () => {
  it('is a no-op when there is no Nomad client', async () => {
    const redis = mockRedis();
    const publisher = new ClusterCapacityPublisher(createOptions({ redis, nomadClient: undefined }));

    publisher.start();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(redis.set).not.toHaveBeenCalled();
  });

  it('publishes one capacity snapshot computed across ready agent nodes', async () => {
    const redis = mockRedis();
    const nomad = mockNomadClient({
      nodes: [readyAgentNode('n1'), readyAgentNode('n2')],
      nodeDetail: (id) => ({ ID: id, Name: id, NodeResources: { Memory: { MemoryMB: 1024 }, Cpu: { CpuShares: 100_000 } } }),
      nodeAllocations: () => [],
    });
    const publisher = new ClusterCapacityPublisher(createOptions({ redis, nomadClient: nomad, agentMemoryReservationMb: 256, agentCpuReservationMhz: 256, maxAgentNodes: 5 }));

    publisher.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(redis.set.mock.calls[0]![0]).toBe(CLUSTER_CAPACITY_KEY);
    expect(redis.set.mock.calls[0]![2]).toBe('EX');
    expect(redis.set.mock.calls[0]![3]).toBe(SERVER_HEALTH_TTL_SECONDS);

    const snap = snapshot(redis);
    expect(snap.readyAgentNodes).toBe(2);
    expect(snap.maxAgentNodes).toBe(5);
    expect(snap.freeSlots).toBe(8); // floor(1024/256)=4 per node, ×2
    expect(snap.totalMemoryMb).toBe(2048);
    expect(snap.agentMemoryReservationMb).toBe(256);
    expect(typeof snap.updatedAt).toBe('string');
  });

  it('considers only ready agent nodes', async () => {
    const redis = mockRedis();
    const nomad = mockNomadClient({
      nodes: [
        readyAgentNode('n1'),
        { ID: 'b1', Status: 'ready', SchedulingEligibility: 'eligible', NodeClass: 'browser' },
      ],
    });
    const publisher = new ClusterCapacityPublisher(createOptions({ redis, nomadClient: nomad }));

    publisher.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(snapshot(redis).readyAgentNodes).toBe(1);
  });

  it('skips the whole cycle when the node list is unavailable', async () => {
    const redis = mockRedis();
    const nomad = mockNomadClient({ nodes: null });
    const publisher = new ClusterCapacityPublisher(createOptions({ redis, nomadClient: nomad }));

    publisher.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(redis.set).not.toHaveBeenCalled();
  });

  it('skips the whole cycle (not an optimistic number) when a node read fails', async () => {
    const redis = mockRedis();
    const nomad = mockNomadClient({
      nodes: [readyAgentNode('n1'), readyAgentNode('n2')],
      nodeAllocations: (id) => (id === 'n2' ? null : []),
    });
    const publisher = new ClusterCapacityPublisher(createOptions({ redis, nomadClient: nomad }));

    publisher.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(redis.set).not.toHaveBeenCalled();
  });

  it('publishes a zeroed snapshot when there are no ready agent nodes', async () => {
    const redis = mockRedis();
    const nomad = mockNomadClient({ nodes: [] });
    const publisher = new ClusterCapacityPublisher(createOptions({ redis, nomadClient: nomad, maxAgentNodes: 3 }));

    publisher.start();
    await vi.advanceTimersByTimeAsync(0);

    const snap = snapshot(redis);
    expect(snap.readyAgentNodes).toBe(0);
    expect(snap.freeSlots).toBe(0);
    expect(snap.maxAgentNodes).toBe(3);
  });
});
