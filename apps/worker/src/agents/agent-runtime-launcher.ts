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

/**
 * AgentRuntimeLauncher — launches, stops, and kills sandboxed agent runtimes.
 *
 * Hides whether the runtime is local Docker, ECS, or another sandbox.
 * V1 uses Docker containers (ADR 003: single container per agent runtime).
 */
export class AgentRuntimeLauncher {
  private readonly runtimes = new Map<string, RuntimeHandle>();

  /**
   * Launch a new isolated agent runtime container.
   * Returns a handle for tracking and cleanup.
   */
  async launch(config: RuntimeLaunchConfig): Promise<RuntimeHandle> {
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
    return handle;
  }

  /**
   * Stop a runtime gracefully (SIGTERM, wait for exit).
   */
  async stop(sessionId: string): Promise<void> {
    const handle = this.runtimes.get(sessionId);
    if (!handle) return;

    // V1: Would send SIGTERM to the container and wait
    this.runtimes.delete(sessionId);
    logger.info({ sessionId, containerId: handle.containerId }, 'Agent runtime stopped');
  }

  /**
   * Kill a runtime immediately (SIGKILL).
   */
  async kill(sessionId: string): Promise<void> {
    const handle = this.runtimes.get(sessionId);
    if (!handle) return;

    // V1: Would SIGKILL the container
    this.runtimes.delete(sessionId);
    logger.warn({ sessionId, containerId: handle.containerId }, 'Agent runtime killed');
  }

  /** Check if a runtime is tracked as running */
  isRunning(sessionId: string): boolean {
    return this.runtimes.has(sessionId);
  }

  /** Get all active runtime handles */
  getActiveRuntimes(): RuntimeHandle[] {
    return [...this.runtimes.values()];
  }
}
