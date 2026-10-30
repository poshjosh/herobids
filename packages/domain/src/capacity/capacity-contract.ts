// Shared contract for capacity-aware starts and demand-aware scale-out.
// Types only: no behaviour is attached here, and the gates stay disabled by default.

export const CAPACITY_SNAPSHOT_SCHEMA_VERSION = 1;

export type CapacityObservationValidity = 'valid' | 'invalid';

export type CapacityWorkloadClassification =
  | 'capacity_blocked'
  | 'not_capacity_remediable'
  | 'unclassified'
  | 'already_assigned';

export interface CapacityNodeObservation {
  nodeId: string;
  datacenter: string;
  pool: string;
  eligible: boolean;
  draining: boolean;
  allocatableMemoryMb: number;
  occupiedMemoryMb: number;
  freeMemoryMb: number;
  allocatableCpuMhz: number;
  occupiedCpuMhz: number;
  freeCpuMhz: number;
}

export interface CapacityWorkloadObservation {
  namespace: string;
  jobId: string;
  taskGroup: string;
  classification: CapacityWorkloadClassification;
  queuedAllocations: number;
  memoryReservationMb: number;
  cpuReservationMhz: number;
  firstSeenAt: string;
  latestObservedAt: string;
}

export interface CapacityInFlightObservation {
  cloudServerId: string;
  requestedAt: string;
  deadlineAt: string;
  templateFingerprint: string;
}

export interface CapacityLimits {
  minNodes: number;
  maxNodes: number;
  incrementMax: number;
  cooldownSeconds: number;
}

export interface CapacitySnapshot {
  schemaVersion: typeof CAPACITY_SNAPSHOT_SCHEMA_VERSION;
  environment: string;
  datacenter: string;
  namespace: string;
  pool: string;
  observedAt: string;
  validity: CapacityObservationValidity;
  configFingerprint: string;
  nodes: readonly CapacityNodeObservation[];
  workloads: readonly CapacityWorkloadObservation[];
  inFlight: readonly CapacityInFlightObservation[];
  limits: CapacityLimits;
}

export type CapacityDecision =
  | { action: 'none'; reason: string }
  | { action: 'scale_out'; nodesToAdd: number; reason: string }
  | { action: 'abort'; reason: string };
