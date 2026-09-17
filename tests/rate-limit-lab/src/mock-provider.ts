import type { ProviderRequestClass } from './types.js';
import type {
  RateBudgetClock,
  SharedBudgetAcquireRequest,
  SharedRateBudgetCoordinator,
} from './rate-limiter.js';
import type { DataCategory, MockProviderConfig, ProviderAttemptRecord } from './types.js';
import type { DeterministicRandom } from './random.js';

interface ProviderWindowState {
  windowStartedAtMs: number;
  consumed: number;
}

export interface MockProviderRequestInput {
  agentId: string;
  requestClass: ProviderRequestClass;
  category: DataCategory;
  viaFallback: boolean;
}

export class MockProvider {
  private readonly limiterRequests = new Map<ProviderRequestClass, SharedBudgetAcquireRequest>();
  private readonly windowState: ProviderWindowState = { windowStartedAtMs: 0, consumed: 0 };
  private queuedRequests = 0;
  private maxQueuedRequests = 0;

  constructor(
    private readonly config: MockProviderConfig,
    private readonly coordinator: SharedRateBudgetCoordinator,
    private readonly clock: RateBudgetClock,
    private readonly random: DeterministicRandom,
  ) {}

  get name(): string {
    return this.config.name;
  }

  getMaxQueuedRequests(): number {
    return this.maxQueuedRequests;
  }

  async request(input: MockProviderRequestInput): Promise<ProviderAttemptRecord> {
    const startedAtMs = this.clock.now();
    let waitMs = 0;
    let queuedMs = 0;

    try {
      const limiterRequest = this.getLimiterRequest(input.requestClass);
      const lease = await this.coordinator.acquire(limiterRequest);
      waitMs = lease.waitMs;
    } catch (error) {
      return {
        provider: this.config.name,
        agentId: input.agentId,
        requestClass: input.requestClass,
        category: input.category,
        outcome: 'rejected_429',
        viaFallback: input.viaFallback,
        waitMs,
        queuedMs,
        latencyMs: this.clock.now() - startedAtMs,
        atMs: this.clock.now(),
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    const queueDecision = await this.applyUpstreamWindow();
    if (queueDecision.outcome === 'rejected_429') {
      return {
        provider: this.config.name,
        agentId: input.agentId,
        requestClass: input.requestClass,
        category: input.category,
        outcome: 'rejected_429',
        viaFallback: input.viaFallback,
        waitMs,
        queuedMs: queueDecision.queuedMs,
        latencyMs: this.clock.now() - startedAtMs,
        atMs: this.clock.now(),
        reason: 'mock upstream returned 429',
      };
    }
    queuedMs = queueDecision.queuedMs;

    const latencyMs = this.sampleLatencyMs();
    await this.clock.sleep(latencyMs);

    const activeOutage = this.getActiveOutage();
    if (activeOutage) {
      return {
        provider: this.config.name,
        agentId: input.agentId,
        requestClass: input.requestClass,
        category: input.category,
        outcome: activeOutage.mode === '429' ? 'rejected_429' : 'error_5xx',
        viaFallback: input.viaFallback,
        waitMs,
        queuedMs,
        latencyMs: this.clock.now() - startedAtMs,
        atMs: this.clock.now(),
        reason: `mock outage ${activeOutage.mode}`,
      };
    }

    if (this.random.next() < this.config.errorRate) {
      return {
        provider: this.config.name,
        agentId: input.agentId,
        requestClass: input.requestClass,
        category: input.category,
        outcome: 'error_5xx',
        viaFallback: input.viaFallback,
        waitMs,
        queuedMs,
        latencyMs: this.clock.now() - startedAtMs,
        atMs: this.clock.now(),
        reason: 'mock transient 5xx',
      };
    }

    return {
      provider: this.config.name,
      agentId: input.agentId,
      requestClass: input.requestClass,
      category: input.category,
      outcome: 'accepted',
      viaFallback: input.viaFallback,
      waitMs,
      queuedMs,
      latencyMs: this.clock.now() - startedAtMs,
      atMs: this.clock.now(),
    };
  }

  private getLimiterRequest(requestClass: ProviderRequestClass): SharedBudgetAcquireRequest {
    const existing = this.limiterRequests.get(requestClass);
    if (existing) {
      return existing;
    }

    const request: SharedBudgetAcquireRequest = {
      provider: this.config.name,
      requestClass,
      budget: this.config.budget,
    };
    this.limiterRequests.set(requestClass, request);
    return request;
  }

  private async applyUpstreamWindow(): Promise<{ outcome?: 'rejected_429'; queuedMs: number }> {
    const upstreamLimit = this.config.upstreamLimit;
    if (!upstreamLimit) {
      return { queuedMs: 0 };
    }

    this.resetWindowIfNeeded(upstreamLimit.windowMs);
    if (this.windowState.consumed < upstreamLimit.requests) {
      this.windowState.consumed += 1;
      return { queuedMs: 0 };
    }

    if (this.config.rateLimitBehavior === 'reject_429') {
      return { outcome: 'rejected_429', queuedMs: 0 };
    }

    const waitMs = Math.max(0, this.windowState.windowStartedAtMs + upstreamLimit.windowMs - this.clock.now());
    this.queuedRequests += 1;
    this.maxQueuedRequests = Math.max(this.maxQueuedRequests, this.queuedRequests);
    await this.clock.sleep(waitMs);
    this.queuedRequests -= 1;

    this.resetWindowIfNeeded(upstreamLimit.windowMs);
    this.windowState.consumed += 1;
    return { queuedMs: waitMs };
  }

  private resetWindowIfNeeded(windowMs: number): void {
    const now = this.clock.now();
    if (now - this.windowState.windowStartedAtMs >= windowMs) {
      this.windowState.windowStartedAtMs = now;
      this.windowState.consumed = 0;
    }
  }

  private getActiveOutage() {
    const now = this.clock.now();
    return this.config.outageWindows?.find((window) => now >= window.startMs && now < window.startMs + window.durationMs);
  }

  private sampleLatencyMs(): number {
    const { p50, p95 } = this.config.latencyMs;
    const max = this.config.latencyMs.max ?? Math.max(p95, Math.ceil(p95 * 1.5));
    const value = this.random.next();

    if (value <= 0.5) {
      return Math.max(1, Math.round((p50 * 0.5) + (p50 * value)));
    }
    if (value <= 0.95) {
      const normalized = (value - 0.5) / 0.45;
      return Math.max(1, Math.round(p50 + ((p95 - p50) * normalized)));
    }

    const normalized = (value - 0.95) / 0.05;
    return Math.max(1, Math.round(p95 + ((max - p95) * normalized)));
  }
}