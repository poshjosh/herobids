import type {
  RuntimePort,
  RuntimeLaunchConfig,
  RuntimeHandle,
  RuntimeInspectResult,
  RuntimeReconcileResult,
  RuntimeTerminationHandler,
  RuntimeTerminationEvent,
  RuntimeError,
  RuntimeStatus,
} from '@herobids/domain';
import { ok, err } from '@herobids/domain';
import { RUNTIME_ERROR_CODES } from '@herobids/domain';
import pino from 'pino';

const logger = pino({ name: 'nomad-runtime-adapter' });

// ── Nomad-Specific Types ────────────────────────────────────────────────────

/**
 * Nomad job configuration for an agent runtime allocation.
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
 */
export interface NomadRuntimeAdapterConfig {
  /** Nomad API base URL (e.g. 'http://nomad-server:4646'). */
  nomadAddr: string;
  /** Nomad ACL token for authenticated API access. */
  token?: string;
  /** Nomad region. */
  region?: string;
  /** Nomad datacenters for agent job placement. */
  datacenters: string[];
  /** Nomad namespace for agent jobs. */
  namespace?: string;
  /** Agent Docker image to use in task config.
   * @deprecated Image is sourced from {@link RuntimeLaunchConfig.image} at launch time.
   * Kept for potential future use (e.g. default fallback). */
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
  /** Interval (ms) between termination polls. */
  terminationPollIntervalMs?: number;
  /** Nomad API request timeout in ms. */
  requestTimeoutMs?: number;
}

// ── Nomad API Response Types ────────────────────────────────────────────────

interface NomadJob {
  ID: string;
  Name: string;
  Status: string;
  JobSummary?: {
    Children?: {
      Dead: number;
      Running: number;
      Pending: number;
    };
  };
}

interface NomadAllocation {
  ID: string;
  JobID: string;
  TaskGroup: string;
  ClientStatus: string;
  DesiredStatus: string;
  CreateTime: number;
  ModifyTime: number;
  TaskStates?: Record<string, {
    State: string;
    Failed: boolean;
    Events?: Array<{
      Type: string;
      DisplayMessage: string;
    }>;
  }>;
}

interface NomadJobListEntry {
  ID: string;
  Name: string;
  Status: string;
  Type: string;
  JobSummary?: NomadJob['JobSummary'];
}

// ── Nomad Job Spec Builder ──────────────────────────────────────────────────

const AGENT_JOB_PREFIX = 'agent-';

function agentJobId(agentId: string): string {
  return `${AGENT_JOB_PREFIX}${agentId}`;
}

function agentIdFromJobId(jobId: string): string | null {
  if (!jobId.startsWith(AGENT_JOB_PREFIX)) return null;
  return jobId.slice(AGENT_JOB_PREFIX.length);
}

/**
 * Normalize a runtime ID to the Nomad job ID format.
 * Accepts both raw agent IDs (e.g. "abc123") and job IDs (e.g. "agent-abc123").
 * This allows callers like `stopByAgentId` to pass either form.
 */
function toJobId(runtimeId: string): string {
  return runtimeId.startsWith(AGENT_JOB_PREFIX) ? runtimeId : agentJobId(runtimeId);
}

interface NomadJobSpec {
  Job: {
    ID: string;
    Name: string;
    Type: 'service';
    Datacenters: string[];
    Namespace?: string;
    Region?: string;
    Priority?: number;
    Meta: Record<string, string>;
    TaskGroups: Array<{
      Name: string;
      Count: number;
      Tasks: Array<{
        Name: string;
        Driver: 'docker';
        Config: {
          image: string;
          env: Record<string, string>;
          labels: Record<string, string>;
          network_mode?: string;
          pids_limit?: number;
        };
        Resources: {
          MemoryMB: number;
          MemoryMaxMB?: number;
          CPU: number;
        };
        LogConfig?: {
          MaxFiles: number;
          MaxFileSizeMB: number;
        };
      }>;
      RestartPolicy: {
        Attempts: number;
        Mode: 'fail';
        Interval?: number;
        Delay?: number;
      };
      Networks?: Array<{
        Mode: string;
      }>;
    }>;
  };
}

function buildNomadJobSpec(
  config: RuntimeLaunchConfig,
  adapterConfig: NomadRuntimeAdapterConfig,
): NomadJobSpec {
  const resources = config.resources;
  const memoryLimitMb = resources.memoryLimitMb || adapterConfig.defaultResources.memoryLimitMb;
  const cpuShares = resources.cpuShares || adapterConfig.defaultResources.cpuShares;
  const maxProcesses = resources.maxProcesses || adapterConfig.defaultResources.maxProcesses;

  // Build Nomad-flavoured labels (Nomad uses 'meta' for job-level, Docker labels for task-level)
  const dockerLabels: Record<string, string> = {
    ...config.labels,
    'herobids.managed-by': 'nomad',
  };

  const jobMeta: Record<string, string> = {
    'herobids.role': 'agent',
    'herobids.agentId': config.agentId,
    'herobids.sessionId': config.sessionId,
  };

  const spec: NomadJobSpec = {
    Job: {
      ID: agentJobId(config.agentId),
      Name: `agent-${config.agentId}`,
      Type: 'service',
      Datacenters: adapterConfig.datacenters,
      Meta: jobMeta,
      TaskGroups: [
        {
          Name: 'agent',
          Count: 1,
          Tasks: [
            {
              Name: 'agent',
              Driver: 'docker',
              Config: {
                image: config.image,
                env: config.env,
                labels: dockerLabels,
                // network_mode only included when set
                ...(adapterConfig.dockerNetwork ? { network_mode: adapterConfig.dockerNetwork } : {}),
                pids_limit: maxProcesses,
              } as NomadJobSpec['Job']['TaskGroups'][0]['Tasks'][0]['Config'],
              Resources: {
                MemoryMB: memoryLimitMb,
                MemoryMaxMB: memoryLimitMb, // hard limit = reservation (no overcommit for agents)
                CPU: cpuShares,
              },
              LogConfig: {
                MaxFiles: 3,
                MaxFileSizeMB: 10,
              },
            },
          ],
          RestartPolicy: {
            Attempts: 0, // HeroBids manages restarts, not Nomad
            Mode: 'fail',
          },
        },
      ],
    },
  };

  if (adapterConfig.namespace) {
    spec.Job.Namespace = adapterConfig.namespace;
  }
  if (adapterConfig.region) {
    spec.Job.Region = adapterConfig.region;
  }

  return spec;
}

// ── Status Mapping ──────────────────────────────────────────────────────────

/**
 * Map Nomad allocation client status to {@link RuntimeStatus}.
 *
 * Nomad ClientStatus values:
 *   pending  → unknown (not yet running)
 *   running  → running
 *   complete → stopped (voluntary exit with code 0)
 *   failed   → crashed (non-zero exit, OOM, or driver error)
 *   lost     → crashed (node lost contact)
 */
function nomadClientStatusToRuntimeStatus(
  clientStatus: string,
  taskState?: { State: string; Failed: boolean },
): RuntimeStatus {
  switch (clientStatus) {
    case 'running':
      return 'running';
    case 'complete':
      return 'stopped';
    case 'failed':
    case 'lost':
      return 'crashed';
    case 'pending':
    default:
      // A pending allocation that has a task in 'dead' with Failed=true
      // implies a startup failure (image pull error, config error, etc.)
      if (taskState?.Failed) {
        return 'crashed';
      }
      return 'unknown';
  }
}

// ── HTTP Helpers ────────────────────────────────────────────────────────────

class NomadApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'NomadApiError';
  }
}

// ── Adapter ─────────────────────────────────────────────────────────────────

/**
 * NomadRuntimeAdapter — {@link RuntimePort} backed by HashiCorp Nomad.
 *
 * Translates {@link RuntimeLaunchConfig} → Nomad job spec JSON, submits jobs
 * via the Nomad HTTP API (PUT /v1/jobs), and maps Nomad allocation states
 * to {@link RuntimeStatus}.
 *
 * ## Termination Detection
 *
 * Replaces Docker event-stream dependence with periodic Nomad allocation
 * polling. The adapter tracks known allocations and compares statuses on
 * each poll — detecting transitions from running → dead/failed/lost.
 *
 * ## Crash Semantics
 *
 * - **voluntary stop**: Nomad job stopped via API → ClientStatus 'complete'
 * - **startup failure**: image pull error, config error → task Failed=true before running
 * - **runtime crash**: OOM, exit code ≠ 0 → ClientStatus 'failed' or 'lost'
 */
export class NomadRuntimeAdapter implements RuntimePort {
  private readonly nomadAddr: string;
  private readonly config: NomadRuntimeAdapterConfig;
  private readonly terminationHandlers = new Set<RuntimeTerminationHandler>();
  private readonly knownAllocations = new Map<string, { agentId: string; sessionId: string; status: RuntimeStatus }>();
  private terminationTimer: ReturnType<typeof setInterval> | null = null;
  private readonly requestTimeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(config: NomadRuntimeAdapterConfig) {
    this.config = config;
    this.nomadAddr = config.nomadAddr.replace(/\/+$/, ''); // strip trailing slashes
    this.requestTimeoutMs = config.requestTimeoutMs ?? 10_000;
    this.pollIntervalMs = config.terminationPollIntervalMs ?? 30_000;
    logger.info({ nomadAddr: this.nomadAddr, namespace: config.namespace }, 'NomadRuntimeAdapter initialized');
  }

  // ── RuntimePort Implementation ──────────────────────────────────────────

  async launch(
    config: RuntimeLaunchConfig,
  ): Promise<{ ok: true; data: RuntimeHandle } | { ok: false; error: RuntimeError }> {
    try {
      const jobSpec = buildNomadJobSpec(config, this.config);
      const jobId = agentJobId(config.agentId);

      // Nomad PUT is idempotent — no pre-check needed. If the job already
      // exists Nomad returns 200 with the existing JobModifyIndex.
      const response = await this.nomadRequest(this._jobPath(jobId), {
        method: 'PUT',
        body: JSON.stringify(jobSpec),
      });

      // Nomad returns 200 with job registration info on success
      if (!response.ok) {
        const body = await response.text();
        throw new NomadApiError(
          `Nomad PUT /v1/job/${jobId} failed (${response.status}): ${body}`,
          response.status,
        );
      }

      // Track the allocation for termination polling
      this.knownAllocations.set(jobId, {
        agentId: config.agentId,
        sessionId: config.sessionId,
        status: 'unknown',
      });

      // Start termination polling on first launch
      this.ensureTerminationPolling();

      const handle: RuntimeHandle = {
        runtimeId: jobId,
        agentId: config.agentId,
        sessionId: config.sessionId,
        startedAt: new Date().toISOString(),
      };

      logger.info({ jobId, agentId: config.agentId }, 'Nomad job registered');
      return ok(handle);
    } catch (error) {
      if (error instanceof NomadApiError) {
        return err({
          code: RUNTIME_ERROR_CODES.LAUNCH_FAILED,
          message: error.message,
          context: { agentId: config.agentId, statusCode: error.statusCode },
        });
      }
      return err({
        code: RUNTIME_ERROR_CODES.LAUNCH_FAILED,
        message: error instanceof Error ? error.message : 'Nomad launch failed',
        context: { agentId: config.agentId },
      });
    }
  }

  async stop(
    runtimeId: string,
  ): Promise<{ ok: true; data: void } | { ok: false; error: RuntimeError }> {
    const jobId = toJobId(runtimeId);
    try {
      // DELETE with purge=true stops the job and removes it from Nomad state
      const response = await this.nomadRequest(
        this._jobPath(jobId, { purge: 'true' }),
        { method: 'DELETE' },
      );

      if (!response.ok && response.status !== 404) {
        const body = await response.text();
        throw new NomadApiError(
          `Nomad DELETE /v1/job/${jobId} failed (${response.status}): ${body}`,
          response.status,
        );
      }

      this.knownAllocations.delete(jobId);
      // Also remove the unprefixed entry if it exists (from stopByAgentId calls)
      this.knownAllocations.delete(runtimeId);
      logger.info({ runtimeId, jobId }, 'Nomad job stopped and purged');
      return ok(undefined);
    } catch (error) {
      if (error instanceof NomadApiError) {
        return err({
          code: RUNTIME_ERROR_CODES.STOP_FAILED,
          message: error.message,
          context: { runtimeId, jobId, statusCode: error.statusCode },
        });
      }
      return err({
        code: RUNTIME_ERROR_CODES.STOP_FAILED,
        message: error instanceof Error ? error.message : 'Nomad stop failed',
        context: { runtimeId, jobId },
      });
    }
  }

  async kill(
    runtimeId: string,
  ): Promise<{ ok: true; data: void } | { ok: false; error: RuntimeError }> {
    const jobId = toJobId(runtimeId);
    try {
      // Find the allocation for this job and force-stop it.
      const allocations = await this.fetchJobAllocations(jobId);
      if (allocations.length > 0) {
        // Signal the allocation to stop immediately
        for (const alloc of allocations) {
          if (alloc.ClientStatus === 'running' || alloc.ClientStatus === 'pending') {
            await this.nomadRequest(
              `/v1/client/allocation/${encodeURIComponent(alloc.ID)}/stop`,
              { method: 'PUT' },
            );
          }
        }
      }

      // Then purge the job to clean up
      const response = await this.nomadRequest(
        this._jobPath(jobId, { purge: 'true' }),
        { method: 'DELETE' },
      );

      if (!response.ok && response.status !== 404) {
        const body = await response.text();
        throw new NomadApiError(
          `Nomad DELETE /v1/job/${jobId} failed (${response.status}): ${body}`,
          response.status,
        );
      }

      this.knownAllocations.delete(jobId);
      this.knownAllocations.delete(runtimeId);
      logger.info({ runtimeId, jobId }, 'Nomad job killed and purged');
      return ok(undefined);
    } catch (error) {
      if (error instanceof NomadApiError) {
        return err({
          code: RUNTIME_ERROR_CODES.KILL_FAILED,
          message: error.message,
          context: { runtimeId, jobId, statusCode: error.statusCode },
        });
      }
      return err({
        code: RUNTIME_ERROR_CODES.KILL_FAILED,
        message: error instanceof Error ? error.message : 'Nomad kill failed',
        context: { runtimeId, jobId },
      });
    }
  }

  async inspect(
    runtimeId: string,
  ): Promise<{ ok: true; data: RuntimeInspectResult } | { ok: false; error: RuntimeError }> {
    const jobId = toJobId(runtimeId);
    try {
      const job = await this.fetchJob(jobId);
      if (!job) {
        return err({
          code: RUNTIME_ERROR_CODES.NOT_FOUND,
          message: `Nomad job ${jobId} not found`,
          context: { runtimeId, jobId },
        });
      }

      const agentId = agentIdFromJobId(jobId) ?? runtimeId;
      const allocations = await this.fetchJobAllocations(jobId);
      const alloc = allocations[0]; // agent jobs have exactly one allocation

      let status: RuntimeStatus = 'unknown';
      if (alloc) {
        const taskState = alloc.TaskStates ? Object.values(alloc.TaskStates)[0] : undefined;
        status = nomadClientStatusToRuntimeStatus(alloc.ClientStatus, taskState);
      }

      return ok({
        runtimeId,
        agentId,
        status,
        startedAt: alloc?.CreateTime
          ? new Date(alloc.CreateTime / 1_000_000).toISOString()
          : undefined,
        finishedAt: undefined, // Nomad doesn't expose this directly in job summary
      });
    } catch (error) {
      return err({
        code: RUNTIME_ERROR_CODES.INSPECT_FAILED,
        message: error instanceof Error ? error.message : 'Nomad inspect failed',
        context: { runtimeId },
      });
    }
  }

  async list(): Promise<{ ok: true; data: RuntimeInspectResult[] } | { ok: false; error: RuntimeError }> {
    try {
      const jobs = await this.fetchAgentJobs();
      const results: RuntimeInspectResult[] = [];

      for (const job of jobs) {
        const agentId = agentIdFromJobId(job.ID);
        if (!agentId) continue;

        // Determine status from job summary when possible (avoids N+1 allocation lookups)
        let status: RuntimeStatus = 'unknown';
        const summary = job.JobSummary;
        if (summary?.Children) {
          if (summary.Children.Running > 0) {
            status = 'running';
          } else if (summary.Children.Dead > 0 && summary.Children.Running === 0) {
            status = job.Status === 'dead' ? 'crashed' : 'stopped';
          }
        }

        results.push({
          runtimeId: job.ID,
          agentId,
          status,
        });
      }

      return ok(results);
    } catch (error) {
      return err({
        code: RUNTIME_ERROR_CODES.LIST_FAILED,
        message: error instanceof Error ? error.message : 'Nomad list failed',
      });
    }
  }

  async reconcile(): Promise<{ ok: true; data: RuntimeReconcileResult } | { ok: false; error: RuntimeError }> {
    try {
      const jobs = await this.fetchAgentJobs();
      const actualJobs = new Map<string, NomadJobListEntry>();

      for (const job of jobs) {
        const agentId = agentIdFromJobId(job.ID);
        if (agentId) {
          actualJobs.set(agentId, job);
        }
      }

      // Compare desired (tracked allocations) vs actual (Nomad jobs)
      const desiredIds = new Set(this.knownAllocations.keys());
      const actualIds = new Set(
        [...actualJobs.values()].map((j) => j.ID),
      );

      // Orphans: jobs in Nomad that we don't track locally
      const orphans = [...actualIds].filter((id) => !desiredIds.has(id));

      // Missing: tracked locally but not found in Nomad
      const missing = [...desiredIds].filter((id) => !actualIds.has(id))
        .map((id) => {
          const tracked = this.knownAllocations.get(id);
          return tracked?.agentId ?? id;
        });

      // Update local tracking from actual state
      for (const [agentId, job] of actualJobs) {
        const jobId = agentJobId(agentId);
        if (!this.knownAllocations.has(jobId)) {
          // Discovered a running job we didn't know about — track it
          this.knownAllocations.set(jobId, {
            agentId,
            sessionId: '', // unknown
            status: 'running',
          });
        }
      }

      // Clean up stale tracking entries for missing jobs
      for (const jobId of missing) {
        this.knownAllocations.delete(jobId);
      }

      return ok({
        orphans,
        missing,
        runningCount: actualJobs.size,
      });
    } catch (error) {
      return err({
        code: RUNTIME_ERROR_CODES.RECONCILE_FAILED,
        message: error instanceof Error ? error.message : 'Nomad reconcile failed',
      });
    }
  }

  onTermination(handler: RuntimeTerminationHandler): () => void {
    this.terminationHandlers.add(handler);
    this.ensureTerminationPolling();
    return () => {
      this.terminationHandlers.delete(handler);
      // Stop polling when no more listeners
      if (this.terminationHandlers.size === 0 && this.terminationTimer) {
        clearInterval(this.terminationTimer);
        this.terminationTimer = null;
      }
    };
  }

  /** Shut down the adapter — stops termination polling. */
  async shutdown(): Promise<void> {
    if (this.terminationTimer) {
      clearInterval(this.terminationTimer);
      this.terminationTimer = null;
    }
    logger.info('NomadRuntimeAdapter shut down');
  }

  // ── Private: Nomad HTTP API ──────────────────────────────────────────────

  /** Build the path for a per-job endpoint, attaching the namespace query param
   * and any extra query parameters via URLSearchParams for correct encoding. */
  private _jobPath(jobId: string, extraParams?: Record<string, string>): string {
    const params = new URLSearchParams();
    if (this.config.namespace) params.set('namespace', this.config.namespace);
    if (extraParams) {
      for (const [k, v] of Object.entries(extraParams)) params.set(k, v);
    }
    const qs = params.toString();
    const encoded = encodeURIComponent(jobId);
    return `/v1/job/${encoded}${qs ? '?' + qs : ''}`;
  }

  private async nomadRequest(
    path: string,
    options: { method: string; body?: string },
  ): Promise<Response> {
    const url = `${this.nomadAddr}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (this.config.token) {
      headers['X-Nomad-Token'] = this.config.token;
    }

    try {
      const response = await fetch(url, {
        method: options.method,
        headers,
        body: options.body,
        signal: controller.signal,
      });
      return response;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async fetchJob(jobId: string): Promise<NomadJob | null> {
    const response = await this.nomadRequest(this._jobPath(jobId), {
      method: 'GET',
    });

    if (response.status === 404) return null;
    if (!response.ok) {
      throw new NomadApiError(
        `Nomad GET /v1/job/${jobId} failed (${response.status})`,
        response.status,
      );
    }

    return (await response.json()) as NomadJob;
  }

  private async fetchJobAllocations(jobId: string): Promise<NomadAllocation[]> {
    // Build the allocations path manually since _jobPath doesn't support path suffixes.
    const params = new URLSearchParams();
    if (this.config.namespace) params.set('namespace', this.config.namespace);
    const qs = params.toString();
    const path = `/v1/job/${encodeURIComponent(jobId)}/allocations${qs ? '?' + qs : ''}`;

    const response = await this.nomadRequest(path, { method: 'GET' });

    if (response.status === 404) return [];
    if (!response.ok) {
      throw new NomadApiError(
        `Nomad GET /v1/job/${jobId}/allocations failed (${response.status})`,
        response.status,
      );
    }

    return (await response.json()) as NomadAllocation[];
  }

  private async fetchAgentJobs(): Promise<NomadJobListEntry[]> {
    // List all jobs, then filter by prefix client-side.
    // Nomad's prefix filtering happens via ?prefix= but returns all job stubs.
    const queryParams = new URLSearchParams();
    if (this.config.namespace) {
      queryParams.set('namespace', this.config.namespace);
    }
    const qs = queryParams.toString();
    const path = `/v1/jobs${qs ? `?${qs}` : ''}`;

    const response = await this.nomadRequest(path, { method: 'GET' });
    if (!response.ok) {
      throw new NomadApiError(
        `Nomad GET /v1/jobs failed (${response.status})`,
        response.status,
      );
    }

    const allJobs = (await response.json()) as NomadJobListEntry[];
    return allJobs.filter((j) => j.ID.startsWith(AGENT_JOB_PREFIX));
  }

  // ── Private: Termination Polling ─────────────────────────────────────────

  private ensureTerminationPolling(): void {
    if (this.terminationTimer) return;

    this.terminationTimer = setInterval(() => {
      void this.pollTerminations();
    }, this.pollIntervalMs);

    // Allow the timer to not keep the process alive
    if (this.terminationTimer && 'unref' in this.terminationTimer) {
      this.terminationTimer.unref();
    }

    logger.info({ intervalMs: this.pollIntervalMs }, 'Nomad termination polling started');
  }

  private async pollTerminations(): Promise<void> {
    if (this.terminationHandlers.size === 0) return;

    try {
      const jobs = await this.fetchAgentJobs();
      const seenJobIds = new Set<string>();

      for (const job of jobs) {
        seenJobIds.add(job.ID);
        const agentId = agentIdFromJobId(job.ID);
        if (!agentId) continue;

        const summary = job.JobSummary?.Children;
        if (!summary) continue;

        // Detect dead/failed jobs that were previously running
        const isDead = summary.Running === 0 && summary.Dead > 0 && summary.Pending === 0;
        if (!isDead) {
          // Still running or pending — update status, no termination event
          this.knownAllocations.set(job.ID, {
            agentId,
            sessionId: this.knownAllocations.get(job.ID)?.sessionId ?? '',
            status: 'running',
          });
          continue;
        }

        // Job is dead — determine crash vs voluntary stop
        const tracked = this.knownAllocations.get(job.ID);
        if (tracked?.status === 'stopped' || tracked?.status === 'crashed') {
          // Already handled
          continue;
        }

        // Look at allocation details for exit code
        let reason: RuntimeTerminationEvent['reason'] = 'scheduler_event';
        try {
          const allocations = await this.fetchJobAllocations(job.ID);
          const alloc = allocations[0];
          if (alloc) {
            const taskState = alloc.TaskStates ? Object.values(alloc.TaskStates)[0] : undefined;
            if (taskState?.Failed || alloc.ClientStatus === 'failed' || alloc.ClientStatus === 'lost') {
              reason = 'scheduler_event';
            } else if (alloc.ClientStatus === 'complete') {
              reason = 'container_exit';
            }
          }
        } catch {
          // Fall through with default reason
        }

        this.knownAllocations.set(job.ID, {
          agentId,
          sessionId: tracked?.sessionId ?? '',
          status: reason === 'container_exit' ? 'stopped' : 'crashed',
        });

        const event: RuntimeTerminationEvent = {
          runtimeId: job.ID,
          agentId,
          sessionId: tracked?.sessionId,
          reason,
        };

        logger.info({ event }, 'Nomad termination detected');
        for (const handler of this.terminationHandlers) {
          void Promise.resolve(handler(event)).catch((err) => {
            logger.warn({ err, agentId }, 'Termination handler error');
          });
        }
      }

      // Remove stale tracking entries for jobs that no longer exist in Nomad
      // (e.g. manually purged outside of HeroBids).
      for (const trackedId of this.knownAllocations.keys()) {
        if (!seenJobIds.has(trackedId)) {
          this.knownAllocations.delete(trackedId);
          logger.info({ jobId: trackedId }, 'Removed stale tracking entry (job gone from Nomad)');
        }
      }
    } catch (error) {
      logger.warn({ error }, 'Nomad termination poll failed, will retry');
    }
  }
}
