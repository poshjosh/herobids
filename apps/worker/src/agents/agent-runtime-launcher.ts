import crypto from 'node:crypto';
import type { Redis } from 'ioredis';
import pino from 'pino';

const logger = pino({ name: 'agent-runtime-launcher' });

export interface RuntimeLaunchConfig {
  agentId: string;
  sessionId: string;
  tradingInstanceId: string;
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
   * Redis client used by the stub to publish synthetic heartbeats.
   * When provided the stub acts as a minimal "always-ready" runtime.
   */
  redis?: Redis;
  /** Stream key prefix for inbound agent messages. Default: 'agent:inbound:' */
  streamKeyPrefix?: string;
  /** Interval between stub heartbeats in ms. Default: 5000 */
  heartbeatIntervalMs?: number;
}

/**
 * AgentRuntimeLauncher — launches, stops, and kills sandboxed agent runtimes.
 *
 * Hides whether the runtime is local Docker, ECS, or another sandbox.
 * V1 uses Docker containers (ADR 003: single container per agent runtime).
 */
export class AgentRuntimeLauncher {
  private readonly runtimes = new Map<string, RuntimeHandle>();
  private readonly heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly redis?: Redis;
  private readonly streamKeyPrefix: string;
  private readonly heartbeatIntervalMs: number;

  constructor(config?: AgentRuntimeLauncherConfig) {
    this.redis = config?.redis;
    this.streamKeyPrefix = config?.streamKeyPrefix ?? 'agent:inbound:';
    this.heartbeatIntervalMs = config?.heartbeatIntervalMs ?? 5_000;
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

    // V1: In production this would shell out to Docker or call the ECS API.
    // For now, we model the contract and track state in memory.
    const handle: RuntimeHandle = {
      containerId: `agent-runtime-${config.sessionId}`,
      agentId: config.agentId,
      sessionId: config.sessionId,
      startedAt: new Date().toISOString(),
    };

    this.runtimes.set(config.sessionId, handle);
    logger.info({ ...handle }, 'Agent runtime launched');

    if (this.redis) {
      this.startStubHeartbeats(handle, config.tradingInstanceId);
    }

    return handle;
  }

  private startStubHeartbeats(handle: RuntimeHandle, tradingInstanceId: string): void {
    const streamKey = `${this.streamKeyPrefix}${tradingInstanceId}`;

    const publish = async (): Promise<void> => {
      const envelope = {
        schemaVersion: 'v1',
        messageId: crypto.randomUUID(),
        correlationId: handle.sessionId,
        initiatorType: 'agent',
        initiatorId: handle.agentId,
        tradingInstanceId,
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
    logger.debug({ sessionId: handle.sessionId, tradingInstanceId, intervalMs: this.heartbeatIntervalMs }, 'Stub heartbeat publisher started');
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

    // V1: Would send SIGTERM to the container and wait
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
   * Kill a runtime immediately (SIGKILL).
   */
  async kill(sessionId: string): Promise<void> {
    const handle = this.runtimes.get(sessionId);
    if (!handle) return;

    const timer = this.heartbeatTimers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this.heartbeatTimers.delete(sessionId);
    }

    // V1: Would SIGKILL the container
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
