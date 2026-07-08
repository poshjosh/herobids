import type {
  RuntimePort,
  RuntimeLaunchConfig,
  RuntimeHandle,
  RuntimeInspectResult,
  RuntimeReconcileResult,
  RuntimeTerminationEvent,
  RuntimeTerminationHandler,
  RuntimeError,
} from '@herobids/domain';
import { ok, err } from '@herobids/domain';
import { RUNTIME_ERROR_CODES } from '@herobids/domain';
import { DockerAgentManager } from './docker-agent-manager.js';
import type { DockerStartOverrides } from './docker-agent-manager.js';
import type { AgentRepository } from '@herobids/db';
import type { PlatformAlertService } from '../alerting/platform-alert-service.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function toDockerEnv(envMap: Record<string, string>): string[] {
  return Object.entries(envMap).map(([k, v]) => `${k}=${v}`);
}

// ── Adapter ─────────────────────────────────────────────────────────────────

/**
 * DockerRuntimeAdapter — implements {@link RuntimePort} using the local Docker daemon.
 *
 * Translates the scheduler-neutral {@link RuntimePort} contract into
 * {@link DockerAgentManager} operations. The manager owns Docker-specific
 * transport (HTTP API calls, event streaming, container lifecycle).
 *
 * This is the production adapter for single-host deployments and the
 * reference implementation for future scheduler adapters (Nomad, ECS).
 *
 * ## Port config passthrough
 *
 * The adapter passes {@link RuntimeLaunchConfig} fields (env, labels,
 * resources, image, network) through to {@link DockerAgentManager.start}
 * as overrides. When the caller provides these via the port, they take
 * precedence over the manager's construction-time defaults. When absent
 * (legacy path), the manager builds its own defaults internally.
 */
export class DockerRuntimeAdapter implements RuntimePort {
  private terminationHandlers = new Set<RuntimeTerminationHandler>();

  /**
   * @param manager A pre-configured DockerAgentManager.
   * @param agentRepo Used by the launcher for crash handling.
   * @param platformAlerts Optional alerting service.
   */
  constructor(
    private readonly manager: DockerAgentManager,
    public readonly agentRepo: AgentRepository,
    public readonly platformAlerts?: PlatformAlertService,
  ) {
    // Bridge Docker termination events → port-level termination contract.
    // When the Docker event stream detects a container crash, notify any
    // subscribers registered via onTermination().
    this.manager.addTerminationListener((agentId, sessionId, reason) => {
      this.notifyTermination({
        runtimeId: agentId,
        agentId,
        sessionId,
        reason: reason as RuntimeTerminationEvent['reason'],
      });
    });
  }

  // ── RuntimePort Implementation ──────────────────────────────────────────

  async launch(
    config: RuntimeLaunchConfig,
  ): Promise<{ ok: true; data: RuntimeHandle } | { ok: false; error: RuntimeError }> {
    try {
      // Build overrides from the port config. When env/labels/resources/image/network
      // are present in the port config, they flow through to the manager as overrides.
      // When absent (legacy path), the manager uses its construction-time defaults.
      const overrides: DockerStartOverrides = {};
      if (Object.keys(config.env).length > 0) {
        overrides.envVars = toDockerEnv(config.env);
      }
      if (Object.keys(config.labels).length > 0) {
        overrides.labels = config.labels;
      }
      if (config.resources) {
        overrides.resources = {
          memoryLimitMb: config.resources.memoryLimitMb,
          cpuShares: config.resources.cpuShares,
          tempStorageMb: config.resources.tempStorageMb,
          maxProcesses: config.resources.maxProcesses,
        };
      }
      if (config.image) {
        overrides.image = config.image;
      }
      if (config.network) {
        overrides.network = config.network;
      }

      const result = await this.manager.start(
        {
          agentId: config.agentId,
          sessionId: config.sessionId,
          agentConfig: {},
          toolPolicy: {},
        },
        Object.keys(overrides).length > 0 ? overrides : undefined,
      );

      return ok({
        runtimeId: result.containerId,
        agentId: config.agentId,
        sessionId: config.sessionId,
        startedAt: new Date().toISOString(),
      });
    } catch (error) {
      return err({
        code: RUNTIME_ERROR_CODES.LAUNCH_FAILED,
        message: error instanceof Error ? error.message : 'Docker launch failed',
        context: { agentId: config.agentId },
      });
    }
  }

  async stop(
    runtimeId: string,
  ): Promise<{ ok: true; data: void } | { ok: false; error: RuntimeError }> {
    try {
      // runtimeId is the Docker container ID from a prior launch() call.
      // Use stopByContainerId which takes the raw container ID directly.
      await this.manager.stopByContainerId(runtimeId);
      return ok(undefined);
    } catch (error) {
      return err({
        code: RUNTIME_ERROR_CODES.STOP_FAILED,
        message: error instanceof Error ? error.message : 'Docker stop failed',
        context: { runtimeId },
      });
    }
  }

  async kill(
    runtimeId: string,
  ): Promise<{ ok: true; data: void } | { ok: false; error: RuntimeError }> {
    try {
      // Docker kill sends SIGKILL immediately — no grace period.
      await this.manager.killContainer(runtimeId);
      return ok(undefined);
    } catch (error) {
      return err({
        code: RUNTIME_ERROR_CODES.KILL_FAILED,
        message: error instanceof Error ? error.message : 'Docker kill failed',
        context: { runtimeId },
      });
    }
  }

  async inspect(
    runtimeId: string,
  ): Promise<{ ok: true; data: RuntimeInspectResult } | { ok: false; error: RuntimeError }> {
    try {
      const result = await this.manager.inspectContainer(runtimeId);
      return ok({
        runtimeId,
        agentId: result.agentId,
        status: result.status,
        exitCode: result.exitCode,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
      });
    } catch (error) {
      return err({
        code: RUNTIME_ERROR_CODES.INSPECT_FAILED,
        message: error instanceof Error ? error.message : 'Docker inspect failed',
        context: { runtimeId },
      });
    }
  }

  async list(): Promise<{ ok: true; data: RuntimeInspectResult[] } | { ok: false; error: RuntimeError }> {
    try {
      const containers = await this.manager.listAgentContainers();
      return ok(
        containers.map((c) => ({
          runtimeId: c.containerId,
          agentId: c.agentId,
          status: c.status,
          exitCode: c.exitCode,
          startedAt: c.startedAt,
          finishedAt: c.finishedAt,
        })),
      );
    } catch (error) {
      return err({
        code: RUNTIME_ERROR_CODES.LIST_FAILED,
        message: error instanceof Error ? error.message : 'Docker list failed',
      });
    }
  }

  async reconcile(): Promise<{ ok: true; data: RuntimeReconcileResult } | { ok: false; error: RuntimeError }> {
    try {
      const result = await this.manager.reconcile();
      return ok(result);
    } catch (error) {
      return err({
        code: RUNTIME_ERROR_CODES.RECONCILE_FAILED,
        message: error instanceof Error ? error.message : 'Docker reconcile failed',
      });
    }
  }

  onTermination(handler: RuntimeTerminationHandler): () => void {
    this.terminationHandlers.add(handler);
    return () => {
      this.terminationHandlers.delete(handler);
    };
  }

  // ── Internal: bridge Docker events → RuntimePort termination ────────────

  /**
   * Notify all registered termination handlers.
   * Called by {@link AgentRuntimeLauncher} when {@link DockerAgentManager}
   * detects a container die event via its event stream.
   */
  notifyTermination(event: RuntimeTerminationEvent): void {
    for (const handler of this.terminationHandlers) {
      void Promise.resolve(handler(event)).catch(() => {
        // Termination handlers are best-effort; errors are logged internally.
      });
    }
  }

  /** Direct access to the underlying manager for launcher-level lifecycle (event stream, reconcile). */
  getManager(): DockerAgentManager {
    return this.manager;
  }
}
