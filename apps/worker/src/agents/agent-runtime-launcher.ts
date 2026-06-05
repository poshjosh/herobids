import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import type { AgentRepository } from '@herobids/db';
import type { PlatformAlertService } from '../alerting/platform-alert-service.js';
import { DockerAgentManager } from './docker-agent-manager.js';
import type { DockerAgentManagerConfig } from './docker-agent-manager.js';
import pino from 'pino';

const logger = pino({ name: 'agent-runtime-launcher' });

export interface RuntimeLaunchConfig {
  agentId: string;
  sessionId: string;
  agentConfig?: Record<string, unknown>;
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

export interface RuntimeHandle {
  containerId: string;
  agentId: string;
  sessionId: string;
  startedAt: string;
}

export interface AgentRuntimeLauncherConfig {
  /**
   * Runtime mode — 'docker' uses DockerAgentManager (production),
   * 'stub' keeps the in-memory fake (local dev without Docker).
   * Reads AGENT_RUNTIME_MODE env var. Default: 'stub'.
   */
  mode?: 'docker' | 'stub';
  /**
   * Redis client used by the stub to publish synthetic heartbeats.
   * When provided the stub acts as a minimal "always-ready" runtime.
   */
  redis?: Redis;
  /** Stream key prefix for inbound agent messages. Default: 'agent:inbound:' */
  streamKeyPrefix?: string;
  /** Interval between stub heartbeats in ms. Default: 5000 */
  heartbeatIntervalMs?: number;
  /** Docker manager config (required when mode='docker') */
  dockerConfig?: DockerAgentManagerConfig;
  agentRepo?: AgentRepository;
  platformAlerts?: PlatformAlertService;
}

/**
 * AgentRuntimeLauncher — launches, stops, and kills sandboxed agent runtimes.
 *
 * Hides whether the runtime is Docker (production) or stub (local dev).
 * Reads AGENT_RUNTIME_MODE env var: 'docker' or 'stub' (default).
 */
export class AgentRuntimeLauncher {
  private readonly runtimes = new Map<string, RuntimeHandle>();
  private readonly heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly redis?: Redis;
  private readonly streamKeyPrefix: string;
  private readonly heartbeatIntervalMs: number;
  private readonly mode: 'docker' | 'stub';
  private readonly dockerManager?: DockerAgentManager;

  constructor(config?: AgentRuntimeLauncherConfig) {
    this.mode = config?.mode ?? (process.env['AGENT_RUNTIME_MODE'] as 'docker' | 'stub' | undefined) ?? 'stub';
    this.redis = config?.redis;
    this.streamKeyPrefix = config?.streamKeyPrefix ?? 'agent:inbound:';
    this.heartbeatIntervalMs = config?.heartbeatIntervalMs ?? 5_000;

    if (this.mode === 'docker') {
      if (!config?.dockerConfig) {
        throw new Error('AgentRuntimeLauncher: dockerConfig is required when mode=docker');
      }
      if (!config.agentRepo) {
        throw new Error('AgentRuntimeLauncher: agentRepo is required when mode=docker');
      }
      this.dockerManager = new DockerAgentManager(config.dockerConfig, config.agentRepo, config.platformAlerts);
    }

    logger.info({ mode: this.mode }, 'Agent runtime launcher initialized');
  }

  /**
   * Start the Docker event stream (docker mode only).
   * Call this after construction to begin crash detection.
   */
  async startEventStream(): Promise<void> {
    if (this.mode === 'docker' && this.dockerManager) {
      await this.dockerManager.startEventStream();
    }
  }

  /** Stop the Docker event stream (docker mode only). */
  stopEventStream(): void {
    if (this.mode === 'docker' && this.dockerManager) {
      this.dockerManager.stopEventStream();
    }
  }

  /**
   * Reconcile running containers against DB (docker mode only).
   */
  async reconcile(): Promise<void> {
    if (this.mode === 'docker' && this.dockerManager) {
      await this.dockerManager.reconcile();
    }
  }

  /**
   * Launch a new isolated agent runtime container.
   * Returns a handle for tracking and cleanup.
   */
  async launch(config: RuntimeLaunchConfig): Promise<RuntimeHandle> {
    const existing = this.runtimes.get(config.sessionId);
    if (existing) {
      return existing;
    }

    if (this.mode === 'docker' && this.dockerManager) {
      const result = await this.dockerManager.start({
        agentId: config.agentId,
        sessionId: config.sessionId,
        agentConfig: config.agentConfig ?? {},
        toolPolicy: config.toolPolicy ?? {},
      });

      const handle: RuntimeHandle = {
        containerId: result.containerId,
        agentId: config.agentId,
        sessionId: config.sessionId,
        startedAt: new Date().toISOString(),
      };
      this.runtimes.set(config.sessionId, handle);
      return handle;
    }

    // Stub mode: simulate a container launch in-memory
    const handle: RuntimeHandle = {
      containerId: `stub-${config.sessionId}`,
      agentId: config.agentId,
      sessionId: config.sessionId,
      startedAt: new Date().toISOString(),
    };

    this.runtimes.set(config.sessionId, handle);
    logger.info({ ...handle, mode: 'stub' }, 'Agent runtime launched (stub)');

    if (this.redis) {
      this.startStubHeartbeats(handle);
    }

    return handle;
  }

  private startStubHeartbeats(handle: RuntimeHandle): void {
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
    if (!handle) return;

    const timer = this.heartbeatTimers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this.heartbeatTimers.delete(sessionId);
    }

    if (this.mode === 'docker' && this.dockerManager) {
      await this.dockerManager.stop(handle.agentId);
    }

    this.runtimes.delete(sessionId);
    logger.info({ sessionId, containerId: handle.containerId }, 'Agent runtime stopped');
  }

  /** Stop all tracked runtimes. */
  async stopAll(): Promise<void> {
    for (const sessionId of [...this.runtimes.keys()]) {
      await this.stop(sessionId);
    }
  }

  /**
   * Stop a runtime forcefully. Sends SIGTERM; Docker issues SIGKILL automatically
   * after a 10-second grace period if the container has not exited by then.
   * Behaves identically to stop() until a zero-grace hard-kill endpoint is needed.
   */
  async kill(sessionId: string): Promise<void> {
    const handle = this.runtimes.get(sessionId);
    if (!handle) return;

    const timer = this.heartbeatTimers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this.heartbeatTimers.delete(sessionId);
    }

    if (this.mode === 'docker' && this.dockerManager) {
      await this.dockerManager.stop(handle.agentId);
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

  /** Get all active runtime handles */
  getActiveRuntimes(): RuntimeHandle[] {
    return [...this.runtimes.values()];
  }
}

