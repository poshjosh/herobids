import type {
  RuntimePort,
  RuntimeLaunchConfig,
  RuntimeHandle,
  RuntimeInspectResult,
  RuntimeReconcileResult,
  RuntimeTerminationHandler,
  RuntimeError,
} from '@herobids/domain';
import { ok, err } from '@herobids/domain';
import { RUNTIME_ERROR_CODES } from '@herobids/domain';

/**
 * StubRuntimeAdapter — in-memory {@link RuntimePort} for local dev and tests.
 *
 * Simulates scheduler operations without requiring a real container runtime.
 * Used when AGENT_RUNTIME_MODE is 'stub'. Heartbeat publishing is handled
 * externally by {@link AgentRuntimeLauncher}, not by this adapter.
 */
export class StubRuntimeAdapter implements RuntimePort {
  private runtimes = new Map<string, RuntimeHandle>();
  private terminationHandlers = new Set<RuntimeTerminationHandler>();
  private counter = 0;

  async launch(config: RuntimeLaunchConfig): Promise<{ ok: true; data: RuntimeHandle } | { ok: false; error: RuntimeError }> {
    this.counter += 1;
    const handle: RuntimeHandle = {
      runtimeId: `stub-${config.agentId}-${this.counter}`,
      agentId: config.agentId,
      sessionId: config.sessionId,
      startedAt: new Date().toISOString(),
    };
    this.runtimes.set(handle.runtimeId, handle);
    return ok(handle);
  }

  async stop(runtimeId: string): Promise<{ ok: true; data: void } | { ok: false; error: RuntimeError }> {
    if (!this.runtimes.has(runtimeId)) {
      return err({ code: RUNTIME_ERROR_CODES.NOT_FOUND, message: `Runtime ${runtimeId} not found` });
    }
    this.runtimes.delete(runtimeId);
    return ok(undefined);
  }

  async kill(runtimeId: string): Promise<{ ok: true; data: void } | { ok: false; error: RuntimeError }> {
    if (!this.runtimes.has(runtimeId)) {
      return err({ code: RUNTIME_ERROR_CODES.NOT_FOUND, message: `Runtime ${runtimeId} not found` });
    }
    this.runtimes.delete(runtimeId);
    return ok(undefined);
  }

  async inspect(runtimeId: string): Promise<{ ok: true; data: RuntimeInspectResult } | { ok: false; error: RuntimeError }> {
    const handle = this.runtimes.get(runtimeId);
    return ok({
      runtimeId,
      agentId: handle?.agentId ?? runtimeId,
      status: handle ? 'running' : 'unknown',
      startedAt: handle?.startedAt,
    });
  }

  async list(): Promise<{ ok: true; data: RuntimeInspectResult[] } | { ok: false; error: RuntimeError }> {
    return ok(
      [...this.runtimes.values()].map((h) => ({
        runtimeId: h.runtimeId,
        agentId: h.agentId,
        status: 'running' as const,
        startedAt: h.startedAt,
      })),
    );
  }

  async reconcile(): Promise<{ ok: true; data: RuntimeReconcileResult } | { ok: false; error: RuntimeError }> {
    return ok({
      orphans: [],
      missing: [],
      runningCount: this.runtimes.size,
    });
  }

  onTermination(handler: RuntimeTerminationHandler): () => void {
    this.terminationHandlers.add(handler);
    return () => {
      this.terminationHandlers.delete(handler);
    };
  }
}
