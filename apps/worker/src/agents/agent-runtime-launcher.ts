import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import type { AgentRepository, AgentDocumentsRepository } from '@herobids/db';
import type {
  RuntimeDescriptor,
  RuntimePort,
  RuntimeResourceProfile,
  DocumentStore,
  RuntimeDocumentMaterializer,
} from '@herobids/domain';
import { ok } from '@herobids/domain';
import { sanitizeFilename } from '@herobids/documents';
import type { PlatformAlertService } from '../alerting/platform-alert-service.js';
import { DockerRuntimeAdapter } from './docker-runtime-adapter.js';
import { DockerAgentManager } from './docker-agent-manager.js';
import type { DockerAgentManagerConfig } from './docker-agent-manager.js';
import { StubRuntimeAdapter } from './stub-runtime-adapter.js';
import {
  buildAgentEnv,
  buildAgentLabels,
} from './runtime-lifecycle.js';
import type { AgentEnvConfig } from './runtime-lifecycle.js';
import { createLogger } from '../logger.js';

const logger = createLogger('agent-runtime-launcher');

// ── Public Types (backward-compatible) ──────────────────────────────────────

/**
 * Configuration passed to {@link AgentRuntimeLauncher.launch}.
 *
 * This is the HeroBids-level launch config — it contains agent-specific
 * payloads (config, tool policy, runtime descriptor) that the launcher
 * translates into a scheduler-neutral {@link RuntimeLaunchConfig} for
 * the port.
 */
export interface LauncherLaunchConfig {
  agentId: string;
  sessionId: string;
  agentConfig?: Record<string, unknown>;
  runtimeDescriptor?: RuntimeDescriptor;
  toolPolicy?: Record<string, unknown>;
  /** Container image for the agent runtime */
  image?: string;
  /** Optional plan tier for resource profile selection (e.g. 'free', 'pro', 'enterprise'). */
  planTier?: string;
  /** Resource limits */
  limits?: {
    cpuShares?: number;
    memoryMb?: number;
    wallClockMs?: number;
    maxProcesses?: number;
    tempStorageMb?: number;
  };
}

/**
 * @deprecated Use {@link LauncherLaunchConfig} instead. Kept for backward compat.
 */
export type RuntimeLaunchConfig = LauncherLaunchConfig;

/**
 * Handle returned after a successful launch, tracked in-memory by the launcher.
 */
export interface LauncherRuntimeHandle {
  containerId: string;
  agentId: string;
  sessionId: string;
  startedAt: string;
}

/**
 * @deprecated Use {@link LauncherRuntimeHandle} instead. Kept for backward compat.
 */
export type RuntimeHandle = LauncherRuntimeHandle;

export interface AgentRuntimeLauncherConfig {
  /**
   * Runtime port — the scheduler-neutral adapter that handles transport.
   *
   * When omitted, the legacy mode/dockerConfig path is used for backward
   * compatibility. New code should always provide a RuntimePort.
   */
  port?: RuntimePort;
  /**
   * Default resource profile used as fallback when the caller does not
   * provide explicit limits. Wired from operator config
   * (`agentRuntime.sandboxDefaults`). When absent, the launcher falls
   * back to zero-value defaults as a last resort.
   */
  defaultResources?: RuntimeResourceProfile;
  /**
   * Per-tier resource profiles keyed by plan tier ID (e.g. 'free', 'pro',
   * 'enterprise'). Resolved at launch time when the caller provides a
   * `planTier`. Profiles take precedence over {@link defaultResources}.
   * Wired from operator config (`agentRuntime.resourceProfiles`).
   */
  resourceProfiles?: Record<string, RuntimeResourceProfile>;
  /**
   * Default plan tier used when the caller does not pass an explicit tier
   * at launch time. Typically the `plans.defaultPlanId` from operator config.
   */
  defaultTier?: string;
  /**
   * Runtime mode — 'docker' uses DockerAgentManager (production),
   * 'stub' keeps the in-memory fake (local dev without Docker).
   * Reads AGENT_RUNTIME_MODE env var. Default: 'stub'.
   *
   * @deprecated Prefer providing `port` directly. Kept for backward compat.
   */
  mode?: 'docker' | 'stub';
  /**
   * Agent env config — used by {@link buildAgentEnv} and {@link buildAgentLabels}
   * to inject environment variables and labels into the runtime. When provided,
   * the launcher builds env/labels via the shared lifecycle functions and passes
   * them through the port. When absent (legacy path), the adapter builds its own.
   */
  envConfig?: AgentEnvConfig;
  /**
   * Redis client used by the stub to publish synthetic heartbeats.
   * When provided the stub acts as a minimal "always-ready" runtime.
   */
  redis?: Redis;
  /** Stream key prefix for inbound agent messages. Default: 'agent:inbound:' */
  streamKeyPrefix?: string;
  /** Interval between stub heartbeats in ms. Default: 5000 */
  heartbeatIntervalMs?: number;
  /** Docker manager config (required when mode='docker' and no port is provided). */
  dockerConfig?: DockerAgentManagerConfig;
  agentRepo?: AgentRepository;
  platformAlerts?: PlatformAlertService;
  /**
   * Repository for querying staged agent documents and marking them
   * as materialized after they are copied into the runtime workspace.
   * When absent, document materialization is skipped.
   */
  documentsRepo?: AgentDocumentsRepository;
  /**
   * Document blob store used to load staged document bodies for
   * materialization. When absent, document materialization is skipped.
   */
  documentStore?: DocumentStore;
  /**
   * Materializer that copies documents into the agent's runtime workspace.
   * When absent, document materialization is skipped.
   */
  documentMaterializer?: RuntimeDocumentMaterializer;
}

// ── Launcher ────────────────────────────────────────────────────────────────

/**
 * AgentRuntimeLauncher — launches, stops, and kills sandboxed agent runtimes.
 *
 * Delegates transport operations to a {@link RuntimePort} adapter. Owns
 * HeroBids lifecycle logic: handle tracking, stub heartbeat publishing,
 * session recovery, and crash reconciliation.
 *
 * ## Architecture
 *
 * ```
 * AgentSessionManager → AgentRuntimeLauncher (lifecycle)
 *                          ↓
 *                     RuntimePort (transport)
 *                    ↓         ↓          ↓
 *              DockerAdapter  StubAdapter  NomadAdapter
 * ```
 */
export class AgentRuntimeLauncher {
  private readonly runtimes = new Map<string, LauncherRuntimeHandle>();
  private readonly heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly redis?: Redis;
  private readonly streamKeyPrefix: string;
  private readonly heartbeatIntervalMs: number;
  private readonly port: RuntimePort;
  private readonly dockerAdapter?: DockerRuntimeAdapter;
  private readonly dockerManager?: DockerAgentManager;
  private readonly agentRepo?: AgentRepository;
  private readonly envConfig?: AgentEnvConfig;
  private readonly defaultResources: RuntimeResourceProfile;
  private readonly resourceProfiles: Record<string, RuntimeResourceProfile>;
  private readonly defaultTier?: string;
  private readonly documentsRepo?: AgentDocumentsRepository;
  private readonly documentStore?: DocumentStore;
  private readonly documentMaterializer?: RuntimeDocumentMaterializer;

  constructor(config?: AgentRuntimeLauncherConfig) {
    this.redis = config?.redis;
    this.streamKeyPrefix = config?.streamKeyPrefix ?? 'agent:inbound:';
    this.heartbeatIntervalMs = config?.heartbeatIntervalMs ?? 5_000;
    this.agentRepo = config?.agentRepo;
    this.envConfig = config?.envConfig;
    this.resourceProfiles = config?.resourceProfiles ?? {};
    this.defaultTier = config?.defaultTier;
    this.defaultResources = config?.defaultResources ?? {
      memoryLimitMb: 0,
      cpuShares: 0,
      maxProcesses: 0,
      tempStorageMb: 0,
    };
    this.documentsRepo = config?.documentsRepo;
    this.documentStore = config?.documentStore;
    this.documentMaterializer = config?.documentMaterializer;

    // Resolve the runtime port: explicit port > legacy mode path
    if (config?.port) {
      this.port = config.port;
      if (config.port instanceof DockerRuntimeAdapter) {
        this.dockerAdapter = config.port;
        this.dockerManager = config.port.getManager();
        // Termination events are bridged by DockerRuntimeAdapter's own constructor.
      }
    } else {
      // Legacy path — construct DockerAgentManager internally from mode + dockerConfig
      const mode = config?.mode ?? (process.env['AGENT_RUNTIME_MODE'] as 'docker' | 'stub' | undefined) ?? 'stub';
      if (mode === 'docker') {
        if (!config?.dockerConfig) {
          throw new Error('AgentRuntimeLauncher: dockerConfig is required when mode=docker');
        }
        if (!config.agentRepo) {
          throw new Error('AgentRuntimeLauncher: agentRepo is required when mode=docker');
        }
        const manager = new DockerAgentManager(config.dockerConfig, config.agentRepo, config.platformAlerts);
        this.dockerManager = manager;
        this.dockerAdapter = new DockerRuntimeAdapter(manager, config.agentRepo, config.platformAlerts);
        this.port = this.dockerAdapter;
      } else {
        // Stub adapter — minimal in-process simulation
        this.port = new StubRuntimeAdapter();
      }
    }

    const portType = this.port.constructor.name;
    logger.info({ portType, hasEnvConfig: !!this.envConfig, tiers: Object.keys(this.resourceProfiles) }, 'Agent runtime launcher initialized');
  }

  /**
   * Resolve the effective {@link RuntimeResourceProfile} for a plan tier.
   *
   * Resolution order:
   * 1. Exact match in `resourceProfiles[tier]`
   * 2. `resourceProfiles[defaultTier]` (when a non-matching tier is requested)
   * 3. `defaultResources` (sandboxDefaults from operator config)
   *
   * This ensures unknown or unconfigured tiers fall back to the operator's
   * default platform profile rather than silently getting zero resources.
   */
  resolveProfile(tier?: string): RuntimeResourceProfile {
    if (tier && this.resourceProfiles[tier]) {
      return this.resourceProfiles[tier]!;
    }
    // When a tier is specified but has no profile entry, fall back to the
    // configured default tier profile (if any) before falling to sandboxDefaults.
    if (tier && this.defaultTier && this.resourceProfiles[this.defaultTier]) {
      logger.debug({ tier, defaultTier: this.defaultTier }, 'No resource profile for tier, falling back to default tier profile');
      return this.resourceProfiles[this.defaultTier]!;
    }
    if (!tier && this.defaultTier && this.resourceProfiles[this.defaultTier]) {
      return this.resourceProfiles[this.defaultTier]!;
    }
    return this.defaultResources;
  }

  /**
   * Start the Docker event stream (Docker adapter only).
   * Call this after construction to begin crash detection.
   */
  async startEventStream(): Promise<void> {
    if (this.dockerManager) {
      await this.dockerManager.startEventStream();
    }
  }

  /** Stop the Docker event stream (Docker adapter only). */
  stopEventStream(): void {
    if (this.dockerManager) {
      this.dockerManager.stopEventStream();
    }
  }

  /**
   * Shut down the runtime adapter — tear down any background polling,
   * timers, or persistent connections. Must be called during graceful
   * worker shutdown to avoid leaking resources.
   */
  async shutdown(): Promise<void> {
    if (this.port.shutdown) {
      await this.port.shutdown();
    }
  }

  /**
   * Reconcile desired vs actual runtimes via the port.
   *
   * Reconciliation compares desired vs actual runtimes and handles:
   * - Orphan cleanup: containers running with no corresponding DB state
   * - Missing detection: agents active in DB but no running container
   * - Crash classification: startup failures vs runtime crashes
   *
   * Falls back to direct DockerAgentManager.reconcile() for legacy
   * callers that bypass the port.
   */
  async reconcile(): Promise<void> {
    // Prefer the port's reconcile method when available.
    const portResult = await this.port.reconcile();
    if (portResult.ok) {
      logger.info(portResult.data, 'Runtime reconcile complete via port');
      return;
    }
    logger.warn({ error: portResult.error }, 'Port reconcile failed, trying legacy path');

    // Legacy fallback for Docker adapter.
    if (this.dockerManager) {
      await this.dockerManager.reconcile();
    }
  }

  /**
   * Launch a new isolated agent runtime container.
   * Returns a handle for tracking and cleanup.
   */
  async launch(config: LauncherLaunchConfig): Promise<LauncherRuntimeHandle> {
    const existing = this.runtimes.get(config.sessionId);
    if (existing) {
      return existing;
    }

    // Build env and labels via shared lifecycle functions when envConfig is available.
    // When absent (legacy path), pass empty objects — the adapter builds its own.
    const agentConfigJson = JSON.stringify({
      ...config.agentConfig,
      ...(config.runtimeDescriptor ? { runtimeDescriptor: config.runtimeDescriptor } : {}),
    });
    const toolPolicyJson = JSON.stringify(config.toolPolicy ?? {});

    const env: Record<string, string> = this.envConfig
      ? buildAgentEnv(
          config.agentId,
          config.sessionId,
          agentConfigJson,
          toolPolicyJson,
          this.envConfig,
        )
      : {};

    const labels: Record<string, string> = this.envConfig
      ? buildAgentLabels(config.agentId, config.sessionId)
      : {};

    const profile = this.resolveProfile(config.planTier);

    const resources: RuntimeResourceProfile = {
      memoryLimitMb: config.limits?.memoryMb ?? profile.memoryLimitMb ?? 512,
      memoryReservationMb: config.limits?.memoryMb !== undefined
        ? undefined // caller set explicit memory; reservation is implicit
        : profile.memoryReservationMb,
      cpuShares: config.limits?.cpuShares ?? profile.cpuShares ?? 256,
      maxProcesses: config.limits?.maxProcesses ?? profile.maxProcesses ?? 50,
      tempStorageMb: config.limits?.tempStorageMb ?? profile.tempStorageMb ?? 100,
      maxWallClockMs: config.limits?.wallClockMs ?? profile.maxWallClockMs,
    };

    const portResult = await this.port.launch({
      agentId: config.agentId,
      sessionId: config.sessionId,
      image: config.image ?? 'herobids-agent:latest',
      env,
      labels,
      resources,
    });

    if (!portResult.ok) {
      logger.error({ error: portResult.error, sessionId: config.sessionId }, 'Runtime port launch failed');
      throw new Error(`Runtime launch failed: ${portResult.error.message}`);
    }

    const handle: LauncherRuntimeHandle = {
      containerId: portResult.data.runtimeId,
      agentId: config.agentId,
      sessionId: config.sessionId,
      startedAt: portResult.data.startedAt,
    };
    this.runtimes.set(config.sessionId, handle);

    // Materialize staged documents into the agent workspace.
    // Non-fatal: the agent still runs without documents on failure.
    if (this.documentsRepo && this.documentStore && this.documentMaterializer) {
      const materializeResult = await this.materializeStagedDocuments(config.agentId, config.sessionId);
      if (!materializeResult.ok) {
        logger.warn({ err: materializeResult.error, agentId: config.agentId, sessionId: config.sessionId }, 'Failed to materialize staged documents — agent will run without them');
      }
    }

    // Stub heartbeat publishing — only fires when the port is a stub
    // (no real runtime to send heartbeats). The Redis check gates this.
    if (this.redis && !this.dockerManager) {
      this.startStubHeartbeats(handle);
    }

    return handle;
  }

  private startStubHeartbeats(handle: LauncherRuntimeHandle): void {
    const streamKey = `${this.streamKeyPrefix}${handle.agentId}`;

    const publish = async (): Promise<void> => {
      const envelope = {
        schemaVersion: 'v1',
        messageId: crypto.randomUUID(),
        correlationId: handle.sessionId,
        initiatorType: 'agent',
        initiatorId: handle.agentId,
        agentId: handle.agentId,
        type: 'agent.runtime.heartbeat',
        createdAt: new Date().toISOString(),
        payload: { sessionId: handle.sessionId, status: 'ready' },
      };
      try {
        await this.redis!.xadd(streamKey, '*', 'envelope', JSON.stringify(envelope));
      } catch (err) {
        logger.warn({ err, sessionId: handle.sessionId }, 'Stub heartbeat publish failed');
      }
    };

    void publish();
    const timer = setInterval(() => void publish(), this.heartbeatIntervalMs);
    this.heartbeatTimers.set(handle.sessionId, timer);
    logger.debug({ sessionId: handle.sessionId, agentId: handle.agentId, intervalMs: this.heartbeatIntervalMs }, 'Stub heartbeat publisher started');
  }

  /**
   * Materialize staged documents into the agent's runtime workspace.
   *
   * Queries staged documents for the agent, loads blobs from the document store,
   * writes them into the workspace via the materializer, and marks them as
   * `materialized` in the database.
   *
   * Non-fatal: returns an error result on failure so the caller can log a
   * warning and proceed with the launch.
   */
  private async materializeStagedDocuments(
    agentId: string,
    sessionId: string,
  ): Promise<{ ok: true; data: void } | { ok: false; error: unknown }> {
    const repo = this.documentsRepo!;
    const store = this.documentStore!;
    const mat = this.documentMaterializer!;

    // 1. Query staged documents
    const stagedDocs = await repo.listByAgent(agentId, { lifecycleState: 'staged' });
    if (stagedDocs.length === 0) return ok(undefined);

    // 2. Load blobs and build file list
    const files: Array<{ relativePath: string; body: Buffer }> = [];
    const materializedIds = new Set<string>();
    for (const doc of stagedDocs) {
      // Original file
      const originalResult = await store.read(doc.originalStoreKey);
      if (!originalResult.ok) {
        logger.warn({ docId: doc.id, storeKey: doc.originalStoreKey, error: originalResult.error }, 'Skipping staged doc — original blob not found');
        continue;
      }
      const safeName = sanitizeFilename(doc.originalFilename);
      files.push({
        relativePath: `original/${doc.id}-${safeName}`,
        body: originalResult.data,
      });
      materializedIds.add(doc.id);

      // Extracted text (if available)
      if (doc.extractedTextStoreKey && doc.extractionStatus === 'ready') {
        const extractedResult = await store.read(doc.extractedTextStoreKey);
        if (extractedResult.ok) {
          files.push({
            relativePath: `extracted/${doc.id}.txt`,
            body: extractedResult.data,
          });
        } else {
          logger.warn({ docId: doc.id, storeKey: doc.extractedTextStoreKey, error: extractedResult.error },
            'Skipping extracted text for staged doc — blob not found');
        }
      }
    }

    if (files.length === 0) {
      // Mark docs whose blobs couldn't be read as failed so they don't retry forever.
      for (const doc of stagedDocs) {
        if (!materializedIds.has(doc.id)) {
          await repo.update(doc.id, { lifecycleState: 'failed' }).catch((err: unknown) => {
            logger.warn({ err, docId: doc.id }, 'Failed to mark doc lifecycle as failed');
          });
        }
      }
      return ok(undefined);
    }

    // 3. Materialize into workspace
    const matResult = await mat.materialize({ agentId, sessionId, files });
    if (!matResult.ok) return matResult;

    // 4. Mark docs as materialized or failed
    for (const doc of stagedDocs) {
      if (materializedIds.has(doc.id)) {
        await repo.update(doc.id, {
          lifecycleState: 'materialized',
          materializedSessionId: sessionId,
        });
      } else {
        await repo.update(doc.id, {
          lifecycleState: 'failed',
        });
      }
    }

    logger.info({ agentId, sessionId, docCount: stagedDocs.length, fileCount: files.length }, 'Staged documents materialized into workspace');
    return ok(undefined);
  }

  /**
   * Refresh documents for all live (running) sessions.
   *
   * Queries staged documents for each tracked runtime and materializes them
   * into the agent's workspace. This allows documents uploaded while an agent
   * is running to become available without a restart.
   *
   * Per-session error isolation: one session's failure does not block others.
   * No-op when document dependencies are not configured.
   */
  async refreshLiveDocuments(): Promise<void> {
    if (!this.documentsRepo || !this.documentStore || !this.documentMaterializer) {
      return; // not configured — nothing to refresh
    }

    let totalMaterialized = 0;
    for (const [sessionId, handle] of this.runtimes) {
      try {
        const stagedCount = (await this.documentsRepo.listByAgent(handle.agentId, { lifecycleState: 'staged' })).length;
        if (stagedCount === 0) continue;

        const result = await this.materializeStagedDocuments(handle.agentId, sessionId);
        if (!result.ok) {
          logger.warn({ err: result.error, agentId: handle.agentId, sessionId },
            'Failed to refresh live documents');
        } else {
          totalMaterialized += stagedCount;
        }
      } catch (err) {
        logger.warn({ err, agentId: handle.agentId, sessionId },
          'Error refreshing live documents for session');
      }
    }
    if (totalMaterialized > 0) {
      logger.info({ totalMaterialized, sessionCount: this.runtimes.size }, 'Live document refresh completed');
    }
  }

  /**
   * Clean up materialized documents when an agent runtime session terminates.
   *
   * Resets documents that were materialized for the given session back to
   * `staged` so they can be re-materialized when the agent restarts.
   * Best-effort: per-document error isolation; failures are logged but
   * never crash the caller.
   *
   * No-op when document dependencies are not configured.
   */
  async cleanupSessionDocuments(agentId: string, sessionId: string): Promise<void> {
    if (!this.documentsRepo) return;

    const docs = await this.documentsRepo.listByAgent(agentId, {
      lifecycleState: 'materialized',
    });

    const sessionDocs = docs.filter((d) => d.materializedSessionId === sessionId);
    if (sessionDocs.length === 0) return;

    for (const doc of sessionDocs) {
      await this.documentsRepo.update(doc.id, {
        lifecycleState: 'staged',
        materializedSessionId: null,
      }).catch((err: unknown) => {
        logger.warn({ err, docId: doc.id }, 'Failed to reset document lifecycle state on session cleanup');
      });
    }

    logger.info({ agentId, sessionId, docCount: sessionDocs.length }, 'Reset materialized documents to staged for terminated session');
  }

  /**
   * Stop a runtime gracefully (SIGTERM, wait for exit).
   */
  async stop(sessionId: string): Promise<void> {
    const handle = this.runtimes.get(sessionId);
    if (!handle) {
      // Handle missing from in-memory map (e.g. worker restarted). Fall back to
      // looking up the session by ID from the DB so we can still stop the
      // runtime by agentId.
      if (this.agentRepo) {
        let session: { agentId: string } | null;
        try {
          session = await this.agentRepo.getSession(sessionId);
        } catch (err) {
          logger.error({ err, sessionId }, 'Failed to look up session for missing handle (DB unreachable)');
          return;
        }
        if (session) {
          const result = await this.port.stop(session.agentId);
          if (!result.ok) {
            logger.warn({ error: result.error, sessionId }, 'Failed to stop agent runtime with missing handle');
          } else {
            logger.info({ sessionId, agentId: session.agentId }, 'Agent runtime stopped (handle was missing, stopped by agentId)');
          }
        }
      }
      return;
    }

    const timer = this.heartbeatTimers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this.heartbeatTimers.delete(sessionId);
    }

    const result = await this.port.stop(handle.containerId);
    if (!result.ok) {
      logger.warn({ error: result.error, sessionId }, 'Port stop returned error');
    }

    this.runtimes.delete(sessionId);
    logger.info({ sessionId, containerId: handle.containerId }, 'Agent runtime stopped');
  }

  /**
   * Stop and remove a runtime by agentId alone — no session handle required.
   * Used when the agent has been deleted and there is no session to look up
   * (e.g. Redis-triggered cleanup after API DELETE /agents/:id).
   */
  async stopByAgentId(agentId: string): Promise<void> {
    const result = await this.port.stop(agentId);
    if (!result.ok) {
      logger.warn({ error: result.error, agentId }, 'Failed to stop runtime by agentId');
    }
  }

  /**
   * Stop all in-memory tracked runtimes.
   *
   * **Do NOT call this on normal worker shutdown.** Agent containers are designed
   * to outlive the worker process and reconnect to the next worker via heartbeats.
   * Killing them on shutdown would interrupt live agents during routine restarts.
   *
   * This method exists for:
   * - Tests that need a clean-room teardown.
   * - Emergency/manual teardowns where all containers must be forcibly stopped.
   */
  async stopAll(): Promise<void> {
    for (const sessionId of [...this.runtimes.keys()]) {
      await this.stop(sessionId);
    }
  }

  /**
   * Stop a runtime forcefully.
   */
  async kill(sessionId: string): Promise<void> {
    const handle = this.runtimes.get(sessionId);
    if (!handle) {
      if (this.agentRepo) {
        let session: { agentId: string } | null;
        try {
          session = await this.agentRepo.getSession(sessionId);
        } catch (err) {
          logger.error({ err, sessionId }, 'Failed to look up session for kill with missing handle (DB unreachable)');
          return;
        }
        if (session) {
          const result = await this.port.kill(session.agentId);
          if (!result.ok) {
            logger.warn({ error: result.error, sessionId }, 'Failed to kill agent runtime with missing handle');
          } else {
            logger.warn({ sessionId, agentId: session.agentId }, 'Agent runtime killed (handle was missing, killed by agentId)');
          }
        }
      }
      return;
    }

    const timer = this.heartbeatTimers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this.heartbeatTimers.delete(sessionId);
    }

    const result = await this.port.kill(handle.containerId);
    if (!result.ok) {
      logger.warn({ error: result.error, sessionId }, 'Port kill returned error');
    }

    this.runtimes.delete(sessionId);
    logger.warn({ sessionId, containerId: handle.containerId }, 'Agent runtime killed');
  }

  /** Check if a runtime is tracked as running */
  isRunning(sessionId: string): boolean {
    return this.runtimes.has(sessionId);
  }

  /** Check if a runtime is tracked. */
  hasRuntime(sessionId: string): boolean {
    return this.runtimes.has(sessionId);
  }

  /**
   * Register a handle for a runtime that survived a worker restart.
   *
   * After a graceful worker shutdown, runtimes keep running and reconnect to
   * the next worker via heartbeats. When the first heartbeat arrives for a
   * session with no in-memory handle, `AgentSessionManager` calls this method
   * to re-establish tracking so that subsequent `stop()` and health-monitor
   * cleanup calls can reach the live runtime.
   */
  registerRecoveredRuntime(agentId: string, sessionId: string): void {
    if (this.runtimes.has(sessionId)) return;
    const handle: LauncherRuntimeHandle = {
      containerId: `recovered-${sessionId}`,
      agentId,
      sessionId,
      startedAt: new Date().toISOString(),
    };
    this.runtimes.set(sessionId, handle);
    logger.info({ sessionId, agentId }, 'Registered recovered runtime handle (runtime survived worker restart)');
  }

  /** Get all active runtime handles */
  getActiveRuntimes(): LauncherRuntimeHandle[] {
    return [...this.runtimes.values()];
  }
}

