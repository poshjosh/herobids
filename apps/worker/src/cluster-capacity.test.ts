import { describe, expect, it } from 'vitest';
import type { AgentNodeSnapshot, NomadNodeAllocation, NomadNodeDetail } from './agents/index.js';
import {
  computeClusterCapacity,
  nodeFreeCpuMhz,
  nodeFreeMemoryMb,
  nodeFreeSlots,
} from './cluster-capacity.js';

function node(opts: { memMb?: number; reservedMemMb?: number; cpuMhz?: number; reservedCpuMhz?: number; name?: string } = {}): NomadNodeDetail {
  const name = opts.name ?? 'n1';
  return {
    ID: name,
    Name: name,
    NodeResources: { Memory: { MemoryMB: opts.memMb ?? 0 }, Cpu: { CpuShares: opts.cpuMhz ?? 0 } },
    ReservedResources: { Memory: { MemoryMB: opts.reservedMemMb ?? 0 }, Cpu: { CpuShares: opts.reservedCpuMhz ?? 0 } },
  };
}

function alloc(opts: { memMb?: number; cpuMhz?: number; status?: string; id?: string }): NomadNodeAllocation {
  return {
    ID: opts.id ?? 'a',
    ClientStatus: opts.status ?? 'running',
    AllocatedResources: { Tasks: { main: { Memory: { MemoryMB: opts.memMb ?? 0 }, Cpu: { CpuShares: opts.cpuMhz ?? 0 } } } },
  };
}

const RES = { memoryMb: 256, cpuMhz: 256 };

describe('nodeFreeMemoryMb', () => {
  it('is total minus reserved minus occupying allocations', () => {
    const n: AgentNodeSnapshot = { detail: node({ memMb: 8192, reservedMemMb: 512 }), allocations: [alloc({ memMb: 256 }), alloc({ memMb: 256 })] };
    expect(nodeFreeMemoryMb(n)).toBe(8192 - 512 - 512);
  });

  it('ignores allocations that do not occupy the node', () => {
    const n: AgentNodeSnapshot = {
      detail: node({ memMb: 4096 }),
      allocations: [alloc({ memMb: 256, status: 'running' }), alloc({ memMb: 256, status: 'complete' })],
    };
    expect(nodeFreeMemoryMb(n)).toBe(4096 - 256);
  });

  it('counts pending and unknown allocations as occupying', () => {
    const n: AgentNodeSnapshot = {
      detail: node({ memMb: 4096 }),
      allocations: [alloc({ memMb: 256, status: 'pending' }), alloc({ memMb: 256, status: 'unknown' })],
    };
    expect(nodeFreeMemoryMb(n)).toBe(4096 - 512);
  });

  it('clamps at zero when allocations exceed capacity', () => {
    const n: AgentNodeSnapshot = { detail: node({ memMb: 512 }), allocations: [alloc({ memMb: 1024 })] };
    expect(nodeFreeMemoryMb(n)).toBe(0);
  });
});

describe('nodeFreeCpuMhz', () => {
  it('is total minus reserved minus occupying allocations', () => {
    const n: AgentNodeSnapshot = { detail: node({ cpuMhz: 4000, reservedCpuMhz: 500 }), allocations: [alloc({ cpuMhz: 256 })] };
    expect(nodeFreeCpuMhz(n)).toBe(4000 - 500 - 256);
  });
});

describe('nodeFreeSlots', () => {
  it('is bound by memory when memory is the scarce resource', () => {
    // mem: floor(1024/256)=4; cpu: floor(8000/256)=31 → min = 4
    const n: AgentNodeSnapshot = { detail: node({ memMb: 1024, cpuMhz: 8000 }), allocations: [] };
    expect(nodeFreeSlots(n, RES)).toBe(4);
  });

  it('is bound by CPU when CPU is the scarce resource', () => {
    // mem: floor(8192/256)=32; cpu: floor(512/256)=2 → min = 2
    const n: AgentNodeSnapshot = { detail: node({ memMb: 8192, cpuMhz: 512 }), allocations: [] };
    expect(nodeFreeSlots(n, RES)).toBe(2);
  });

  it('floors partial slots (fragments do not count)', () => {
    const n: AgentNodeSnapshot = { detail: node({ memMb: 1000, cpuMhz: 8000 }), allocations: [] };
    expect(nodeFreeSlots(n, RES)).toBe(3);
  });

  it('returns zero for a non-positive reservation rather than dividing by zero', () => {
    const n: AgentNodeSnapshot = { detail: node({ memMb: 1024, cpuMhz: 1024 }), allocations: [] };
    expect(nodeFreeSlots(n, { memoryMb: 0, cpuMhz: 256 })).toBe(0);
    expect(nodeFreeSlots(n, { memoryMb: 256, cpuMhz: 0 })).toBe(0);
  });
});

describe('computeClusterCapacity', () => {
  it('sums slots and memory across nodes without pooling fragments', () => {
    // Two nodes each with 1000MB/8000MHz free → floor(1000/256)=3 slots each = 6, not floor(2000/256)=7.
    const nodes: AgentNodeSnapshot[] = [
      { detail: node({ memMb: 1000, cpuMhz: 8000, name: 'n1' }), allocations: [] },
      { detail: node({ memMb: 1000, cpuMhz: 8000, name: 'n2' }), allocations: [] },
    ];
    const cap = computeClusterCapacity(nodes, RES, 5);
    expect(cap.readyAgentNodes).toBe(2);
    expect(cap.maxAgentNodes).toBe(5);
    expect(cap.freeSlots).toBe(6);
    expect(cap.freeMemoryMb).toBe(2000);
    expect(cap.totalMemoryMb).toBe(2000);
    expect(cap.agentMemoryReservationMb).toBe(256);
    expect(cap.agentCpuReservationMhz).toBe(256);
  });

  it('reflects CPU-bound slots in the aggregate', () => {
    // One node: mem floor(8192/256)=32, cpu floor(512/256)=2 → 2 slots.
    const nodes: AgentNodeSnapshot[] = [{ detail: node({ memMb: 8192, cpuMhz: 512 }), allocations: [] }];
    expect(computeClusterCapacity(nodes, RES, 5).freeSlots).toBe(2);
  });

  it('returns a zeroed summary (not NaN) for no ready nodes', () => {
    const cap = computeClusterCapacity([], RES, 5);
    expect(cap).toEqual({
      readyAgentNodes: 0,
      maxAgentNodes: 5,
      freeSlots: 0,
      freeMemoryMb: 0,
      totalMemoryMb: 0,
      agentMemoryReservationMb: 256,
      agentCpuReservationMhz: 256,
    });
  });
});
