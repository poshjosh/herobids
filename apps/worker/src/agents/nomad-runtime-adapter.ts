import type {
  RuntimePort,
  RuntimeLaunchConfig,
  RuntimeHandle,
  RuntimeInspectResult,
  RuntimeReconcileResult,
  RuntimeTerminationHandler,
  RuntimeError,
} from '@herobids/domain';
import { ok, RUNTIME_ERROR_CODES } from '@herobids/domain';

// ── Nomad-Specific Types ────────────────────────────────────────────────────

/**
 * Nomad job configuration for an agent runtime allocation.
 *
 * This is the Nomad-oriented adapter interface defined in Phase 1.
 * Full cluster implementation comes in Phase 4.
 */
export interface NomadAgentJobConfig {
  /** Nomad region (default: 'global'). */
  region?: string;
  /** Nomad datacenters to target. */
  datacenters: string[];
  /** Nomad namespace for agent isolation. */
  namespace?: string;
  /** Job priority (0-100, higher = more important). */
  priority?: number;
  /** Constraint expressions for node selection. */
  constraints?: Array<{
    attribute: string;
    operator: '=' | '!=' | '>' | '<' | 'regexp' | 'set_contains';
    value: string;
  }>;
}

/**
 * Nomad-specific config passed to the adapter constructor.
 * Phase 1 defines the interface; values come from operator config in Phase 4.
 */
export interface NomadRuntimeAdapterConfig {
  /** Nomad API base URL (e.g. 'http://nomad-server:4646'). */
  nomadAddr: string;
  /** Nomad region. */
  region?: string;
  /** Nomad datacenters for agent job placement. */
  datacenters: string[];
  /** Nomad namespace for agent jobs. */
  namespace?: string;
  /** Agent Docker image to use in task config. */
  agentImage: string;
  /** Docker network for agent tasks. */
  dockerNetwork?: string;
  /** Default resource profile applied when not specified per-tier. */
  defaultResources: {
    memoryLimitMb: number;
    cpuShares: number;
    tempStorageMb: number;
    maxProcesses: number;
  };
}

// ── Adapter Skeleton ────────────────────────────────────────────────────────

/**
 * NomadRuntimeAdapter — {@link RuntimePort} backed by HashiCorp Nomad.
 *
 * **Phase 1 skeleton only.** All methods throw "not implemented".
 * Full implementation comes in Phase 4 after cluster topology and
 * shared-service connectivity are established.
 *
 * The adapter will:
 * - Translate {@link RuntimeLaunchConfig} → Nomad job spec JSON
 * - Submit jobs via Nomad HTTP API (`PUT /v1/jobs`)
 * - Stop allocations via `DELETE /v1/job/{id}`
 * - Watch allocation status via Nomad event stream
 * - Map Nomad alloc states to {@link RuntimeStatus}
 */
export class NomadRuntimeAdapter implements RuntimePort {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_config: NomadRuntimeAdapterConfig) {
    // Phase 4: initialise Nomad API client, validate connectivity.
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async launch(_config: RuntimeLaunchConfig): Promise<{ ok: true; data: RuntimeHandle } | { ok: false; error: RuntimeError }> {
    return { ok: false, error: { code: RUNTIME_ERROR_CODES.LAUNCH_FAILED, message: 'NomadRuntimeAdapter.launch: not implemented (Phase 4)' } };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async stop(_runtimeId: string): Promise<{ ok: true; data: void } | { ok: false; error: RuntimeError }> {
    return { ok: false, error: { code: RUNTIME_ERROR_CODES.STOP_FAILED, message: 'NomadRuntimeAdapter.stop: not implemented (Phase 4)' } };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async kill(_runtimeId: string): Promise<{ ok: true; data: void } | { ok: false; error: RuntimeError }> {
    return { ok: false, error: { code: RUNTIME_ERROR_CODES.KILL_FAILED, message: 'NomadRuntimeAdapter.kill: not implemented (Phase 4)' } };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async inspect(_runtimeId: string): Promise<{ ok: true; data: RuntimeInspectResult } | { ok: false; error: RuntimeError }> {
    return { ok: false, error: { code: RUNTIME_ERROR_CODES.INSPECT_FAILED, message: 'NomadRuntimeAdapter.inspect: not implemented (Phase 4)' } };
  }

  async list(): Promise<{ ok: true; data: RuntimeInspectResult[] } | { ok: false; error: RuntimeError }> {
    return { ok: false, error: { code: RUNTIME_ERROR_CODES.LIST_FAILED, message: 'NomadRuntimeAdapter.list: not implemented (Phase 4)' } };
  }

  async reconcile(): Promise<{ ok: true; data: RuntimeReconcileResult } | { ok: false; error: RuntimeError }> {
    return { ok: false, error: { code: RUNTIME_ERROR_CODES.RECONCILE_FAILED, message: 'NomadRuntimeAdapter.reconcile: not implemented (Phase 4)' } };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onTermination(_handler: RuntimeTerminationHandler): () => void {
    return () => { /* no-op — not implemented */ };
  }
}
