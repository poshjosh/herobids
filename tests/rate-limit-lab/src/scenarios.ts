import type { AgentSimConfig, MockProviderConfig, ScenarioConfig, ScenarioId } from './types.js';

const FIFTEEN_MINUTES_MS = 15 * 60_000;
const FIVE_MINUTES_MS = 5 * 60_000;

function createBaseProviders(): MockProviderConfig[] {
  return [
    {
      name: 'dexscreener',
      budget: {
        requestsPerMinute: 60,
        burstCapacity: 10,
        maxWaitMs: 60_000,
        classReservations: {
          'execution-critical': 1,
          'price-support': 2,
        },
      },
      latencyMs: { p50: 180, p95: 420, max: 700 },
      errorRate: 0.01,
      rateLimitBehavior: 'reject_429',
      upstreamLimit: { requests: 60, windowMs: 60_000 },
    },
    {
      name: 'geckoterminal',
      budget: {
        requestsPerMinute: 20,
        burstCapacity: 6,
        maxWaitMs: 90_000,
        classReservations: {
          'price-support': 1,
          regime: 1,
        },
      },
      latencyMs: { p50: 220, p95: 650, max: 950 },
      errorRate: 0.02,
      rateLimitBehavior: 'queue_and_delay',
      upstreamLimit: { requests: 18, windowMs: 60_000 },
    },
    {
      name: 'hyperliquid',
      budget: {
        requestsPerMinute: 600,
        burstCapacity: 30,
        maxWaitMs: 10_000,
      },
      latencyMs: { p50: 70, p95: 160, max: 260 },
      errorRate: 0.005,
      rateLimitBehavior: 'reject_429',
      upstreamLimit: { requests: 600, windowMs: 60_000 },
    },
    {
      name: 'bybit',
      budget: {
        requestsPerMinute: 120,
        burstCapacity: 12,
        maxWaitMs: 20_000,
      },
      latencyMs: { p50: 110, p95: 260, max: 400 },
      errorRate: 0.01,
      rateLimitBehavior: 'reject_429',
      upstreamLimit: { requests: 120, windowMs: 60_000 },
    },
    {
      name: 'binance',
      budget: {
        requestsPerMinute: 1_200,
        burstCapacity: 100,
        maxWaitMs: 5_000,
      },
      latencyMs: { p50: 45, p95: 90, max: 140 },
      errorRate: 0.002,
      rateLimitBehavior: 'reject_429',
      upstreamLimit: { requests: 1_200, windowMs: 60_000 },
    },
  ];
}

function cloneProviders(): MockProviderConfig[] {
  return createBaseProviders().map((provider) => ({
    ...provider,
    budget: {
      ...provider.budget,
      classReservations: provider.budget.classReservations ? { ...provider.budget.classReservations } : undefined,
    },
    latencyMs: { ...provider.latencyMs },
    upstreamLimit: provider.upstreamLimit ? { ...provider.upstreamLimit } : undefined,
    outageWindows: provider.outageWindows?.map((window) => ({ ...window })),
  }));
}

function createAgent(id: string, config: Omit<AgentSimConfig, 'id'>): AgentSimConfig {
  return { id, ...config };
}

export function getScenarioConfig(scenarioId: ScenarioId): ScenarioConfig {
  switch (scenarioId) {
    case 'A': {
      return {
        id: 'A',
        name: 'Single agent free-tier soak',
        description: 'One agent on a 15 minute loop for 100 ticks using free-tier budgets.',
        durationMs: FIFTEEN_MINUTES_MS * 100,
        providers: cloneProviders(),
        agents: [
          createAgent('agent-alpha', {
            role: 'mixed',
            tickIntervalMs: FIFTEEN_MINUTES_MS,
            tickCount: 100,
            requestsPerTick: [
              { provider: 'dexscreener', requestClass: 'price-support', category: 'price', count: 1, fallbackProviders: ['hyperliquid'] },
              { provider: 'geckoterminal', requestClass: 'discovery', category: 'discovery', count: 1, fallbackProviders: ['dexscreener'] },
              { provider: 'binance', requestClass: 'regime', category: 'regime', count: 1 },
            ],
          }),
        ],
        notes: ['Baseline soak. Pressure should stay low and rejection rate should remain near zero.'],
      };
    }
    case 'B': {
      return {
        id: 'B',
        name: 'Shared free-tier budget',
        description: 'Three agents tick simultaneously against shared free-tier provider budgets.',
        durationMs: 60 * 10_000,
        providers: cloneProviders(),
        agents: [
          createAgent('agent-bravo', {
            role: 'mixed',
            tickIntervalMs: 10_000,
            tickCount: 60,
            requestsPerTick: [
              { provider: 'dexscreener', requestClass: 'price-support', category: 'price', count: 1, fallbackProviders: ['hyperliquid'] },
              { provider: 'dexscreener', requestClass: 'discovery', category: 'discovery', count: 2, fallbackProviders: ['geckoterminal'] },
              { provider: 'binance', requestClass: 'regime', category: 'regime', count: 1 },
            ],
          }),
          createAgent('agent-charlie', {
            role: 'mixed',
            tickIntervalMs: 10_000,
            tickCount: 60,
            requestsPerTick: [
              { provider: 'dexscreener', requestClass: 'price-support', category: 'price', count: 1, fallbackProviders: ['hyperliquid'] },
              { provider: 'dexscreener', requestClass: 'discovery', category: 'discovery', count: 2, fallbackProviders: ['geckoterminal'] },
              { provider: 'bybit', requestClass: 'price-support', category: 'price', count: 1, fallbackProviders: ['hyperliquid'] },
            ],
          }),
          createAgent('agent-delta', {
            role: 'mixed',
            tickIntervalMs: 10_000,
            tickCount: 60,
            requestsPerTick: [
              { provider: 'dexscreener', requestClass: 'price-support', category: 'price', count: 1, fallbackProviders: ['hyperliquid'] },
              { provider: 'dexscreener', requestClass: 'discovery', category: 'discovery', count: 2, fallbackProviders: ['geckoterminal'] },
              { provider: 'binance', requestClass: 'regime', category: 'regime', count: 1 },
            ],
          }),
        ],
        notes: ['Scenario B thresholds are encoded as explicit PASS or FAIL checks in the report.'],
      };
    }
    case 'C': {
      const providers = cloneProviders();
      const dexscreener = providers.find((provider) => provider.name === 'dexscreener');
      if (dexscreener) {
        dexscreener.outageWindows = [{ startMs: 120_000, durationMs: FIVE_MINUTES_MS, mode: '429' }];
      }

      return {
        id: 'C',
        name: 'Provider degradation',
        description: 'DexScreener returns 429 for five simulated minutes to test fallback and recovery.',
        durationMs: 20 * 30_000,
        providers,
        agents: [
          createAgent('agent-echo', {
            role: 'execution',
            tickIntervalMs: 30_000,
            tickCount: 20,
            requestsPerTick: [
              { provider: 'dexscreener', requestClass: 'price-support', category: 'price', count: 1, fallbackProviders: ['hyperliquid', 'bybit'] },
              { provider: 'dexscreener', requestClass: 'discovery', category: 'discovery', count: 1, fallbackProviders: ['geckoterminal'] },
            ],
          }),
          createAgent('agent-foxtrot', {
            role: 'mixed',
            tickIntervalMs: 30_000,
            tickCount: 20,
            requestsPerTick: [
              { provider: 'dexscreener', requestClass: 'price-support', category: 'price', count: 1, fallbackProviders: ['hyperliquid'] },
              { provider: 'binance', requestClass: 'regime', category: 'regime', count: 1 },
            ],
          }),
        ],
        notes: ['Fallback usage should spike during the outage and settle on the first post-outage successful DexScreener refresh.'],
      };
    }
    case 'D': {
      const providers = cloneProviders();
      const geckoterminal = providers.find((provider) => provider.name === 'geckoterminal');
      if (geckoterminal?.upstreamLimit) {
        geckoterminal.upstreamLimit.requests = 10;
      }

      return {
        id: 'D',
        name: 'Burst demand regime change',
        description: 'Three agents generate a synchronized burst that should create queueing and elevated latency.',
        durationMs: 24 * 5_000,
        providers,
        agents: [
          createAgent('agent-golf', {
            role: 'mixed',
            tickIntervalMs: 5_000,
            tickCount: 24,
            requestsPerTick: [
              { provider: 'dexscreener', requestClass: 'price-support', category: 'price', count: 2, fallbackProviders: ['hyperliquid'] },
              { provider: 'geckoterminal', requestClass: 'discovery', category: 'discovery', count: 3, fallbackProviders: ['dexscreener'] },
              { provider: 'binance', requestClass: 'regime', category: 'regime', count: 2 },
            ],
          }),
          createAgent('agent-hotel', {
            role: 'mixed',
            tickIntervalMs: 5_000,
            tickCount: 24,
            requestsPerTick: [
              { provider: 'dexscreener', requestClass: 'price-support', category: 'price', count: 2, fallbackProviders: ['hyperliquid'] },
              { provider: 'geckoterminal', requestClass: 'discovery', category: 'discovery', count: 3, fallbackProviders: ['dexscreener'] },
              { provider: 'bybit', requestClass: 'price-support', category: 'price', count: 1, fallbackProviders: ['hyperliquid'] },
            ],
          }),
          createAgent('agent-india', {
            role: 'mixed',
            tickIntervalMs: 5_000,
            tickCount: 24,
            requestsPerTick: [
              { provider: 'dexscreener', requestClass: 'price-support', category: 'price', count: 2, fallbackProviders: ['hyperliquid'] },
              { provider: 'geckoterminal', requestClass: 'discovery', category: 'discovery', count: 3, fallbackProviders: ['dexscreener'] },
              { provider: 'binance', requestClass: 'regime', category: 'regime', count: 2 },
            ],
          }),
        ],
        notes: ['Expect queue depth on GeckoTerminal and some degraded latency under the burst.'],
      };
    }
    case 'E': {
      const providers = cloneProviders();
      const dexscreener = providers.find((provider) => provider.name === 'dexscreener');
      if (dexscreener) {
        dexscreener.budget = {
          requestsPerMinute: 30,
          burstCapacity: 3,
          maxWaitMs: 10_000,
          classReservations: {
            'execution-critical': 1,
            'price-support': 1,
          },
        };
        dexscreener.upstreamLimit = { requests: 30, windowMs: 60_000 };
      }

      return {
        id: 'E',
        name: 'Discovery versus execution priority',
        description: 'An execution-heavy agent shares the same provider with an explorer generating discovery traffic.',
        durationMs: 30 * 5_000,
        providers,
        agents: [
          createAgent('agent-juliet', {
            role: 'execution',
            tickIntervalMs: 5_000,
            tickCount: 30,
            requestsPerTick: [
              { provider: 'dexscreener', requestClass: 'execution-critical', category: 'execution', count: 1, fallbackProviders: ['hyperliquid'] },
              { provider: 'dexscreener', requestClass: 'price-support', category: 'price', count: 1, fallbackProviders: ['hyperliquid'] },
            ],
          }),
          createAgent('agent-kilo', {
            role: 'discovery',
            tickIntervalMs: 5_000,
            tickCount: 30,
            requestsPerTick: [
              { provider: 'dexscreener', requestClass: 'discovery', category: 'discovery', count: 3, fallbackProviders: ['geckoterminal'] },
            ],
          }),
        ],
        notes: ['Discovery should absorb most of the pain; execution and price-support requests should not starve.'],
      };
    }
    default: {
      const exhausted: never = scenarioId;
      throw new Error(`Unsupported scenario ${exhausted}`);
    }
  }
}

export function listScenarioIds(): ScenarioId[] {
  return ['A', 'B', 'C', 'D', 'E'];
}