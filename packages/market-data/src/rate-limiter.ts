import type { ProviderRequestClass, RequestGate } from './types.js';

export interface RateLimiterConfig {
  requestsPerMinute: number;
  burstCapacity?: number;
  maxWaitMs?: number;
}

export interface SharedBudgetConfig extends RateLimiterConfig {
  classReservations?: Partial<Record<ProviderRequestClass, number>>;
}

export interface SharedBudgetAcquireRequest {
  provider: string;
  requestClass: ProviderRequestClass;
  budget: SharedBudgetConfig;
}

export interface SharedBudgetLease {
  waitMs: number;
  remainingTokens: number;
}

export interface SharedRateBudgetCoordinator {
  acquire(request: SharedBudgetAcquireRequest): Promise<SharedBudgetLease>;
}

export interface RateBudgetClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface RedisEvalClient {
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

const REQUEST_CLASS_PRIORITY: ProviderRequestClass[] = [
  'execution-critical',
  'price-support',
  'regime',
  'discovery',
  'enrichment',
];

const DEFAULT_CLOCK: RateBudgetClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

function getCapacity(config: RateLimiterConfig): number {
  return config.burstCapacity ?? config.requestsPerMinute;
}

function getProtectedTokens(
  requestClass: ProviderRequestClass,
  reservations: Partial<Record<ProviderRequestClass, number>> | undefined,
): number {
  if (!reservations) {
    return 0;
  }

  let protectedTokens = 0;
  for (const priorityClass of REQUEST_CLASS_PRIORITY) {
    if (priorityClass === requestClass) {
      break;
    }
    protectedTokens += reservations[priorityClass] ?? 0;
  }
  return protectedTokens;
}

interface AttemptResult {
  acquired: boolean;
  waitMs: number;
  remainingTokens: number;
}

interface TokenBucketState {
  tokens: number;
  lastRefill: number;
}

/**
 * Simple token-bucket rate limiter.
 * Per-process (in-memory). If multiple worker instances run in parallel,
 * shared rate limiting would need Redis — out of scope.
 */
export class TokenBucketRateLimiter {
  private tokens: number;
  private readonly capacity: number;
  private readonly refillRate: number; // tokens per ms
  private lastRefill: number;
  private readonly maxWaitMs: number;

  constructor(config: RateLimiterConfig) {
    this.capacity = config.burstCapacity ?? config.requestsPerMinute;
    this.tokens = this.capacity;
    this.refillRate = config.requestsPerMinute / 60_000;
    this.lastRefill = Date.now();
    this.maxWaitMs = config.maxWaitMs ?? 30_000;
  }

  async acquire(): Promise<void> {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    const waitMs = (1 - this.tokens) / this.refillRate;
    if (waitMs > this.maxWaitMs) {
      throw new Error(`Rate limit exceeded — would need to wait ${Math.ceil(waitMs)}ms (max: ${this.maxWaitMs}ms)`);
    }

    await this.sleep(Math.ceil(waitMs));
    this.refill();
    this.tokens -= 1;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export class InMemoryRateBudgetCoordinator implements SharedRateBudgetCoordinator {
  private readonly states = new Map<string, TokenBucketState>();

  constructor(private readonly clock: RateBudgetClock = DEFAULT_CLOCK) {}

  async acquire(request: SharedBudgetAcquireRequest): Promise<SharedBudgetLease> {
    const startedAt = this.clock.now();
    const maxWaitMs = request.budget.maxWaitMs ?? 30_000;

    while (true) {
      const attempt = this.attemptAcquire(request);
      if (attempt.acquired) {
        return {
          waitMs: this.clock.now() - startedAt,
          remainingTokens: attempt.remainingTokens,
        };
      }

      const elapsed = this.clock.now() - startedAt;
      if (attempt.waitMs <= 0 || elapsed + attempt.waitMs > maxWaitMs) {
        throw new Error(
          `Rate limit exceeded for ${request.provider}/${request.requestClass} — would need to wait ${Math.ceil(attempt.waitMs)}ms (max: ${maxWaitMs}ms)`,
        );
      }

      await this.clock.sleep(Math.ceil(attempt.waitMs));
    }
  }

  private attemptAcquire(request: SharedBudgetAcquireRequest): AttemptResult {
    const now = this.clock.now();
    const state = this.getState(request.provider, request.budget, now);
    const capacity = getCapacity(request.budget);
    const refillRate = request.budget.requestsPerMinute / 60_000;
    const protectedTokens = getProtectedTokens(request.requestClass, request.budget.classReservations);
    const requiredTokens = 1 + protectedTokens;

    this.refill(state, request.budget, now);

    if (requiredTokens > capacity) {
      return { acquired: false, waitMs: Number.POSITIVE_INFINITY, remainingTokens: state.tokens };
    }

    if (state.tokens >= requiredTokens) {
      state.tokens -= 1;
      return { acquired: true, waitMs: 0, remainingTokens: state.tokens };
    }

    const deficit = requiredTokens - state.tokens;
    return {
      acquired: false,
      waitMs: deficit / refillRate,
      remainingTokens: state.tokens,
    };
  }

  private getState(provider: string, budget: SharedBudgetConfig, now: number): TokenBucketState {
    const existing = this.states.get(provider);
    if (existing) {
      return existing;
    }

    const state: TokenBucketState = {
      tokens: getCapacity(budget),
      lastRefill: now,
    };
    this.states.set(provider, state);
    return state;
  }

  private refill(state: TokenBucketState, budget: SharedBudgetConfig, now: number): void {
    const elapsed = now - state.lastRefill;
    if (elapsed <= 0) {
      return;
    }

    const capacity = getCapacity(budget);
    const refillRate = budget.requestsPerMinute / 60_000;
    state.tokens = Math.min(capacity, state.tokens + elapsed * refillRate);
    state.lastRefill = now;
  }
}

const REDIS_ACQUIRE_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local refillRate = tonumber(ARGV[3])
local requiredTokens = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'tokens', 'lastRefill')
local tokens = tonumber(data[1])
local lastRefill = tonumber(data[2])

if tokens == nil then
  tokens = capacity
end

if lastRefill == nil then
  lastRefill = now
end

local elapsed = now - lastRefill
if elapsed > 0 then
  tokens = math.min(capacity, tokens + (elapsed * refillRate))
  lastRefill = now
end

if tokens >= requiredTokens then
  tokens = tokens - 1
  redis.call('HMSET', key, 'tokens', tokens, 'lastRefill', lastRefill)
  redis.call('PEXPIRE', key, 120000)
  return {1, 0, tokens}
end

redis.call('HMSET', key, 'tokens', tokens, 'lastRefill', lastRefill)
redis.call('PEXPIRE', key, 120000)
local deficit = requiredTokens - tokens
local waitMs = math.ceil(deficit / refillRate)
return {0, waitMs, tokens}
`;

export class RedisRateBudgetCoordinator implements SharedRateBudgetCoordinator {
  constructor(
    private readonly redis: RedisEvalClient,
    private readonly clock: RateBudgetClock = DEFAULT_CLOCK,
  ) {}

  async acquire(request: SharedBudgetAcquireRequest): Promise<SharedBudgetLease> {
    const startedAt = this.clock.now();
    const maxWaitMs = request.budget.maxWaitMs ?? 30_000;

    while (true) {
      const attempt = await this.attemptAcquire(request);
      if (attempt.acquired) {
        return {
          waitMs: this.clock.now() - startedAt,
          remainingTokens: attempt.remainingTokens,
        };
      }

      const elapsed = this.clock.now() - startedAt;
      if (attempt.waitMs <= 0 || elapsed + attempt.waitMs > maxWaitMs) {
        throw new Error(
          `Rate limit exceeded for ${request.provider}/${request.requestClass} — would need to wait ${Math.ceil(attempt.waitMs)}ms (max: ${maxWaitMs}ms)`,
        );
      }

      await this.clock.sleep(Math.ceil(attempt.waitMs));
    }
  }

  private async attemptAcquire(request: SharedBudgetAcquireRequest): Promise<AttemptResult> {
    const capacity = getCapacity(request.budget);
    const protectedTokens = getProtectedTokens(request.requestClass, request.budget.classReservations);
    const requiredTokens = 1 + protectedTokens;
    if (requiredTokens > capacity) {
      return { acquired: false, waitMs: Number.POSITIVE_INFINITY, remainingTokens: 0 };
    }

    const rawResult = await this.redis.eval(
      REDIS_ACQUIRE_SCRIPT,
      1,
      `market-data:budget:${request.provider}`,
      this.clock.now(),
      capacity,
      request.budget.requestsPerMinute / 60_000,
      requiredTokens,
    ) as [number, number, number] | Array<string | number>;

    const numericResult = rawResult.map((value) => Number(value));
    const acquiredFlag = numericResult[0] ?? 0;
    const waitMs = numericResult[1] ?? Number.POSITIVE_INFINITY;
    const remainingTokens = numericResult[2] ?? 0;
    return {
      acquired: acquiredFlag === 1,
      waitMs,
      remainingTokens,
    };
  }
}

export class CoordinatedRateLimiter implements RequestGate {
  constructor(
    private readonly coordinator: SharedRateBudgetCoordinator,
    private readonly request: SharedBudgetAcquireRequest,
  ) {}

  acquire(): Promise<void> {
    return this.coordinator.acquire(this.request).then(() => undefined);
  }
}

export function createSharedRateBudgetCoordinator(options?: {
  redisClient?: RedisEvalClient;
  clock?: RateBudgetClock;
}): SharedRateBudgetCoordinator {
  if (options?.redisClient) {
    return new RedisRateBudgetCoordinator(options.redisClient, options.clock ?? DEFAULT_CLOCK);
  }
  return new InMemoryRateBudgetCoordinator(options?.clock ?? DEFAULT_CLOCK);
}
