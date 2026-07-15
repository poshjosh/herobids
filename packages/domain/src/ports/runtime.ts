// ── Resource Profile ────────────────────────────────────────────────────────

/**
 * Per-tier configurable resource profile for agent runtimes.
 *
 * Every field must be explicit — no adapter is allowed to silently apply
 * a different value for the same profile. The operator config drives these
 * values; the adapter translates them to the scheduler's native format
 * (Docker HostConfig, Nomad resources stanza, ECS task definition, etc.).
 */
export interface RuntimeResourceProfile {
  /** Hard memory limit in MB (OOM kill boundary). */
  memoryLimitMb: number;
  /** Memory reservation in MB (soft, used for scheduling decisions). TODO(Phase 4): wire into scheduler-specific config. */
  memoryReservationMb?: number;
  /** CPU shares (relative weight; e.g. 256 ≈ 0.25 vCPU on a 1024-scale). */
  cpuShares: number;
  /** Max number of PIDs / processes inside the runtime. */
  maxProcesses: number;
  /** Temp storage limit in MB (e.g. /tmp tmpfs size). */
  tempStorageMb: number;
  /** Wall-clock timeout in ms (0 = no limit, runtime is killed after this). */
  maxWallClockMs?: number;
}

// ── Launch Config ───────────────────────────────────────────────────────────

/** Scheduler-neutral launch configuration for an agent runtime. */
export interface RuntimeLaunchConfig {
  agentId: string;
  sessionId: string;
  /** Container / task image. */
  image: string;
  /** Environment variables as key-value pairs. Each adapter transforms to its target format. */
  env: Record<string, string>;
  /** Metadata labels for the runtime (agentId, sessionId, role). */
  labels: Record<string, string>;
  /** Resource profile — per-tier configurable. */
  resources: RuntimeResourceProfile;
  /** Network to join (adapter-specific interpretation; Docker network name, Nomad network stanza, etc.). */
  network?: string;
}

// ── Handle & Status ─────────────────────────────────────────────────────────

/** Opaque handle returned after a successful launch. */
export interface RuntimeHandle {
  /** Scheduler-assigned unique runtime identifier. */
  runtimeId: string;
  agentId: string;
  sessionId: string;
  startedAt: string;
}

/** Observable runtime status. */
export type RuntimeStatus = 'running' | 'stopped' | 'crashed' | 'unknown';

/** Result of inspecting a single runtime. */
export interface RuntimeInspectResult {
  runtimeId: string;
  agentId: string;
  status: RuntimeStatus;
  exitCode?: number;
  startedAt?: string;
  finishedAt?: string;
}

// ── Reconciliation ──────────────────────────────────────────────────────────

/** Result of a reconciliation scan comparing desired vs actual runtimes. */
export interface RuntimeReconcileResult {
  /** Runtime IDs that exist but shouldn't (orphans). */
  orphans: string[];
  /** Agent IDs that should be running but have no runtime. */
  missing: string[];
  /** Total running runtimes counted. */
  runningCount: number;
}

// ── Termination Events ──────────────────────────────────────────────────────

/** Event emitted when a runtime terminates (crashes or exits). */
export interface RuntimeTerminationEvent {
  runtimeId: string;
  agentId: string;
  sessionId?: string;
  /** Source classifier — caller decides crash taxonomy from this. */
  reason: 'container_exit' | 'scheduler_event' | 'reconcile_no_container';
  exitCode?: number;
}

/** Handler for runtime termination events. */
export type RuntimeTerminationHandler = (
  event: RuntimeTerminationEvent,
) => void | Promise<void>;

// ── Runtime Error ───────────────────────────────────────────────────────────

/** A runtime operation error with a namespaced code. */
export interface RuntimeError {
  /** Dot-namespaced code from {@link RUNTIME_ERROR_CODES}. */
  code: string;
  /** Human-readable description. */
  message: string;
  /** Optional structured metadata for diagnostics. */
  context?: Record<string, unknown>;
}

/** Well-known error codes for runtime operations. */
export const RUNTIME_ERROR_CODES = {
  LAUNCH_FAILED: 'runtime.launch_failed',
  STOP_FAILED: 'runtime.stop_failed',
  KILL_FAILED: 'runtime.kill_failed',
  INSPECT_FAILED: 'runtime.inspect_failed',
  LIST_FAILED: 'runtime.list_failed',
  RECONCILE_FAILED: 'runtime.reconcile_failed',
  TIMEOUT: 'runtime.timeout',
  NOT_FOUND: 'runtime.not_found',
  ALREADY_EXISTS: 'runtime.already_exists',
} as const;

/** Helper to construct a {@link RuntimeError} with a known error code. */
export function runtimeError(
  code: string,
  message: string,
  context?: Record<string, unknown>,
): RuntimeError {
  return { code, message, context };
}

// ── The Port ────────────────────────────────────────────────────────────────

import type { Result } from '../result.js';

/**
 * RuntimePort — scheduler-neutral contract for agent runtime placement.
 *
 * Each adapter (Docker, Nomad, stub) implements this interface to provide
 * transport-level operations. OpenAIdom lifecycle logic (env var injection,
 * crash classification, reconciliation semantics) lives in shared code
 * that consumes this port.
 *
 * All methods return {@link Result}`<T, RuntimeError>` — adapters must
 * never throw. Errors carry a code from {@link RUNTIME_ERROR_CODES}.
 */
export interface RuntimePort {
  /** Launch a new agent runtime. Returns a handle for tracking. */
  launch(config: RuntimeLaunchConfig): Promise<Result<RuntimeHandle, RuntimeError>>;

  /** Gracefully stop a runtime by its scheduler-assigned ID. */
  stop(runtimeId: string): Promise<Result<void, RuntimeError>>;

  /** Forcefully kill a runtime (no grace period). */
  kill(runtimeId: string): Promise<Result<void, RuntimeError>>;

  /** Inspect a runtime's current status. */
  inspect(runtimeId: string): Promise<Result<RuntimeInspectResult, RuntimeError>>;

  /** List all runtimes managed by this scheduler. */
  list(): Promise<Result<RuntimeInspectResult[], RuntimeError>>;

  /**
   * Reconcile desired vs actual runtimes.
   * Returns counts of orphans, missing runtimes, and total running count.
   */
  reconcile(): Promise<Result<RuntimeReconcileResult, RuntimeError>>;

  /**
   * Subscribe to runtime termination events (crashes, exits).
   * Returns an unsubscribe function.
   *
   * The adapter is responsible for detecting terminations via its native
   * mechanism (Docker event stream, Nomad allocation watch, etc.) and
   * invoking the handler for each detected event.
   */
  onTermination(handler: RuntimeTerminationHandler): () => void;

  /**
   * Shut down the adapter — tear down any background polling, timers,
   * or persistent connections that would otherwise leak on process exit.
   * Optional: only adapters that hold long-lived resources need to implement this.
   */
  shutdown?(): Promise<void>;
}
