import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import type { AgentRepository } from '@herobids/db';
import type {
  RuntimeDescriptor,
  RuntimePort,
  RuntimeResourceProfile,
  RuntimeTerminationEvent,
} from '@herobids/domain';
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
import pino from 'pino';

const logger = pino({ name: 'agent-runtime-launcher' });

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

  constructor(config?: AgentRuntimeLauncherConfig) {
    this.redis = config?.redis;
    this.streamKeyPrefix = config?.streamKeyPrefix ?? 'agent:inbound:';
    this.heartbeatIntervalMs = config?.heartbeatIntervalMs ?? 5_000;
    this.agentRepo = config?.agentRepo;
    this.envConfig = config?.envConfig;
    this.defaultResources = config?.defaultResources ?? {
      memoryLimitMb: 0,
      cpuShares: 0,
      maxProcesses: 0,
      tempStorageMb: 0,
    };

    // Resolve the runtime port: explicit port > legacy mode path
    if (config?.port) {
      this.port = config.port;
      if (config.port instanceof DockerRuntimeAdapter) {
        this.dockerAdapter = config.port;
        this.dockerManager = config.port.getManager();
        // Bridge Docker termination events → port termination contract.
        // This ensures onTermination() subscribers on the port are notified
        // when the Docker event stream detects a container crash.
        this.dockerManager.addTerminationListener((agentId, sessionId, reason) => {
          this.dockerAdapter?.notifyTermination({
            runtimeId: agentId,
            agentId,
            sessionId,
            reason: reason as RuntimeTerminationEvent['reason'],
          });
        });
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
    logger.info({ portType, hasEnvConfig: !!this.envConfig }, 'Agent runtime launcher initialized');
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

    const resources: RuntimeResourceProfile = {
      memoryLimitMb: config.limits?.memoryMb ?? (this.defaultResources.memoryLimitMb || 512),
      cpuShares: config.limits?.cpuShares ?? (this.defaultResources.cpuShares || 256),
      maxProcesses: config.limits?.maxProcesses ?? (this.defaultResources.maxProcesses || 10),
      tempStorageMb: config.limits?.tempStorageMb ?? (this.defaultResources.tempStorageMb || 100),
      maxWallClockMs: config.limits?.wallClockMs ?? (this.defaultResources.maxWallClockMs || undefined),
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

