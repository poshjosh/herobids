import { allocationOccupiesNode, type AgentNodeSnapshot } from './agents/index.js';

/**
 * Cluster agent-capacity summary, surfaced to the admin dashboard.
 *
 * Mirrors the figures infra/hetzner/scripts/check-nomad-capacity.sh computes for the
 * autoscaler, so the dashboard agrees with scaling decisions. `maxAgentNodes` is the
 * operator-configured ceiling the dashboard shows; the real ceiling is enforced by
 * Terraform, not here.
 */
export interface ClusterCapacity {
  readyAgentNodes: number;
  maxAgentNodes: number;
  freeSlots: number;
  freeMemoryMb: number;
  totalMemoryMb: number;
  /** MB reserved per agent slot used to derive freeSlots. */
  agentMemoryReservationMb: number;
  /** CPU (MHz) reserved per agent slot used to derive freeSlots. */
  agentCpuReservationMhz: number;
}

/** Reservation sizes per agent slot, matching the autoscaler. */
export interface SlotReservation {
  memoryMb: number;
  cpuMhz: number;
}

/** Memory (MB) an allocation holds, summed across its tasks. */
function allocationMemoryMb(node: AgentNodeSnapshot['allocations'][number]): number {
  const tasks = node.AllocatedResources?.Tasks;
  if (!tasks) return 0;
  let total = 0;
  for (const task of Object.values(tasks)) {
    const mb = task.Memory?.MemoryMB;
    if (typeof mb === 'number' && Number.isFinite(mb)) total += mb;
  }
  return total;
}

/** CPU (MHz) an allocation holds, summed across its tasks. */
function allocationCpuMhz(node: AgentNodeSnapshot['allocations'][number]): number {
  const tasks = node.AllocatedResources?.Tasks;
  if (!tasks) return 0;
  let total = 0;
  for (const task of Object.values(tasks)) {
    const mhz = task.Cpu?.CpuShares;
    if (typeof mhz === 'number' && Number.isFinite(mhz)) total += mhz;
  }
  return total;
}

/**
 * Free allocatable memory (MB) on a node: total − host-reserved − sum of occupying
 * allocations, clamped at 0. Matches check-nomad-capacity.sh's per-node fit.
 */
export function nodeFreeMemoryMb(node: AgentNodeSnapshot): number {
  const total = node.detail.NodeResources?.Memory?.MemoryMB ?? 0;
  const reserved = node.detail.ReservedResources?.Memory?.MemoryMB ?? 0;
  const allocated = node.allocations.filter(allocationOccupiesNode).reduce((sum, a) => sum + allocationMemoryMb(a), 0);
  return Math.max(total - reserved - allocated, 0);
}

/** Free allocatable CPU (MHz) on a node: total − host-reserved − occupying allocations, clamped at 0. */
export function nodeFreeCpuMhz(node: AgentNodeSnapshot): number {
  const total = node.detail.NodeResources?.Cpu?.CpuShares ?? 0;
  const reserved = node.detail.ReservedResources?.Cpu?.CpuShares ?? 0;
  const allocated = node.allocations.filter(allocationOccupiesNode).reduce((sum, a) => sum + allocationCpuMhz(a), 0);
  return Math.max(total - reserved - allocated, 0);
}

/**
 * Whole agent slots that fit one node, bound by whichever resource runs out first:
 * `min(freeMemory / memReservation, freeCpu / cpuReservation)`. Matches the autoscaler's
 * `capacity_node_slots`. Fragments are never pooled across nodes.
 */
export function nodeFreeSlots(node: AgentNodeSnapshot, reservation: SlotReservation): number {
  if (reservation.memoryMb <= 0 || reservation.cpuMhz <= 0) return 0;
  const byMemory = Math.floor(nodeFreeMemoryMb(node) / reservation.memoryMb);
  const byCpu = Math.floor(nodeFreeCpuMhz(node) / reservation.cpuMhz);
  return Math.min(byMemory, byCpu);
}

/**
 * Aggregate cluster capacity across the ready agent nodes. Pure: the caller supplies the
 * already-read node snapshots (from readAgentNodes) plus operator config.
 */
export function computeClusterCapacity(
  nodes: AgentNodeSnapshot[],
  reservation: SlotReservation,
  maxAgentNodes: number,
): ClusterCapacity {
  let freeSlots = 0;
  let freeMemoryMb = 0;
  let totalMemoryMb = 0;

  for (const node of nodes) {
    freeSlots += nodeFreeSlots(node, reservation);
    freeMemoryMb += nodeFreeMemoryMb(node);
    totalMemoryMb += node.detail.NodeResources?.Memory?.MemoryMB ?? 0;
  }

  return {
    readyAgentNodes: nodes.length,
    maxAgentNodes,
    freeSlots,
    freeMemoryMb,
    totalMemoryMb,
    agentMemoryReservationMb: reservation.memoryMb,
    agentCpuReservationMhz: reservation.cpuMhz,
  };
}
