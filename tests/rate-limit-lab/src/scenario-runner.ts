import {
  createSharedRateBudgetCoordinator,
  type SharedRateBudgetCoordinator,
} from './rate-limiter.js';
import { MockProvider } from './mock-provider.js';
import { createDeterministicRandom } from './random.js';
import type {
  AgentStats,
  DataCategory,
  MetricStatus,
  ProviderAttemptRecord,
  ProviderStats,
  ScenarioConfig,
  ScenarioRunResult,
  ScenarioVerdict,
  ThresholdCheck,
} from './types.js';
import { VirtualClock, flushMicrotasks } from './virtual-clock.js';

interface RunnerOptions {
  seed?: number | string;
  coordinator?: SharedRateBudgetCoordinator;
}

interface MutableAgentState {
  agentId: string;
  role: AgentStats['role'];
  callsMade: number;
  callsAccepted: number;
  callsRejected: number;
  fallbackActivations: number;
  staleDataEvents: number;
  starvationEvents: number;
  latenciesMs: number[];
  waitTimesMs: number[];
}

interface MutableProviderState {
  attempted: number;
  accepted: number;
  rejected429: number;
  errors5xx: number;
  fallbackAccepted: number;
  latenciesMs: number[];
  waitTimesMs: number[];
}

interface OutageRecoveryState {
  provider: string;
  endMs: number;
  recoveredAtMs?: number;
}

interface LogicalRequestOutcome {
  accepted: boolean;
  latencyMs: number;
  usedFallback: boolean;
}

function getPercentile(values: number[], percentile: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function toAgentStats(state: MutableAgentState): AgentStats {
  return {
    agentId: state.agentId,
    role: state.role,
    callsMade: state.callsMade,
    callsAccepted: state.callsAccepted,
    callsRejected: state.callsRejected,
    fallbackActivations: state.fallbackActivations,
    staleDataEvents: state.staleDataEvents,
    starvationEvents: state.starvationEvents,
    p50LatencyMs: getPercentile(state.latenciesMs, 50),
    p95LatencyMs: getPercentile(state.latenciesMs, 95),
    maxWaitMs: state.waitTimesMs.length > 0 ? Math.max(...state.waitTimesMs) : 0,
  };
}

function toProviderStats(provider: string, state: MutableProviderState, maxQueueDepth: number): ProviderStats {
  return {
    provider,
    attempted: state.attempted,
    accepted: state.accepted,
    rejected429: state.rejected429,
    errors5xx: state.errors5xx,
    fallbackAccepted: state.fallbackAccepted,
    averageLatencyMs: state.latenciesMs.length > 0 ? state.latenciesMs.reduce((sum, value) => sum + value, 0) / state.latenciesMs.length : 0,
    p95LatencyMs: getPercentile(state.latenciesMs, 95),
    averageWaitMs: state.waitTimesMs.length > 0 ? state.waitTimesMs.reduce((sum, value) => sum + value, 0) / state.waitTimesMs.length : 0,
    rejectionRatePct: state.attempted > 0 ? (state.rejected429 / state.attempted) * 100 : 0,
    maxQueueDepth,
  };
}

function deriveMetricStatus(condition: boolean, warnCondition?: boolean): MetricStatus {
  if (condition) {
    return 'PASS';
  }
  if (warnCondition) {
    return 'WARN';
  }
  return 'FAIL';
}

function isExecutionSensitive(category: DataCategory): boolean {
  return category === 'execution' || category === 'price';
}

function computeThresholdChecks(result: Pick<ScenarioRunResult, 'scenario' | 'summary'>): ThresholdCheck[] {
  const { scenario, summary } = result;
  if (scenario.id === 'B') {
    return [
      {
        metric: 'Execution-priority starvation events',
        value: String(summary.executionPriorityStarvationEvents),
        target: '0',
        status: summary.executionPriorityStarvationEvents === 0 ? 'PASS' : 'FAIL',
      },
      {
        metric: 'Price staleness',
        value: `${(summary.maxPriceStalenessMs / 1_000).toFixed(1)}s`,
        target: '<= 60s',
        status: summary.maxPriceStalenessMs <= 60_000 ? 'PASS' : 'FAIL',
      },
      {
        metric: 'Discovery staleness',
        value: `${(summary.maxDiscoveryStalenessMs / 1_000).toFixed(1)}s`,
        target: '<= 300s',
        status: summary.maxDiscoveryStalenessMs <= 300_000 ? 'PASS' : 'FAIL',
      },
      {
        metric: 'Max provider rejection rate',
        value: `${summary.maxProviderRejectionRatePct.toFixed(1)}%`,
        target: '< 10%',
        status: summary.maxProviderRejectionRatePct < 10 ? 'PASS' : 'FAIL',
      },
      {
        metric: 'Recovery time after outage',
        value: summary.recoveryTimeMs === undefined ? 'N/A' : `${(summary.recoveryTimeMs / 1_000).toFixed(1)}s`,
        target: '<= 60s when outage is simulated',
        status: summary.recoveryTimeMs === undefined ? 'N/A' : summary.recoveryTimeMs <= 60_000 ? 'PASS' : 'FAIL',
      },
    ];
  }

  return [
    {
      metric: 'Execution-priority starvation events',
      value: String(summary.executionPriorityStarvationEvents),
      target: '0',
      status: summary.executionPriorityStarvationEvents === 0 ? 'PASS' : 'FAIL',
    },
    {
      metric: 'Max provider rejection rate',
      value: `${summary.maxProviderRejectionRatePct.toFixed(1)}%`,
      target: '< 20%',
      status: deriveMetricStatus(summary.maxProviderRejectionRatePct < 20, summary.maxProviderRejectionRatePct <= 30),
    },
    {
      metric: 'Price staleness',
      value: `${(summary.maxPriceStalenessMs / 1_000).toFixed(1)}s`,
      target: '<= 300s',
      status: deriveMetricStatus(summary.maxPriceStalenessMs <= 300_000, summary.maxPriceStalenessMs <= 600_000),
    },
  ];
}

function computeVerdict(summary: ScenarioRunResult['summary'], thresholdChecks: ThresholdCheck[]): { verdict: ScenarioVerdict; reason: string } {
  if (thresholdChecks.length > 0 && thresholdChecks.every((check) => check.status === 'PASS' || check.status === 'N/A')) {
    return { verdict: 'PASS', reason: 'All explicit scenario thresholds passed.' };
  }

  if (thresholdChecks.some((check) => check.status === 'FAIL')) {
    return { verdict: 'FAIL', reason: 'One or more explicit threshold checks failed.' };
  }

  if (summary.executionPriorityStarvationEvents > 0) {
    return { verdict: 'FAIL', reason: 'Execution-priority traffic starved under load.' };
  }

  if (summary.totalRequestsRejected429 > 0 || summary.totalErrors5xx > 0 || summary.fallbackActivations > 0 || summary.maxQueueDepth > 0) {
    return { verdict: 'DEGRADED', reason: 'The system stayed functional but required fallback, queueing, or incurred upstream rejections.' };
  }

  return { verdict: 'PASS', reason: 'The system remained within thresholds without starvation or meaningful degradation.' };
}

function buildObservations(result: Pick<ScenarioRunResult, 'scenario' | 'providerStats' | 'summary'>): string[] {
  const observations: string[] = [...(result.scenario.notes ?? [])];
  const mostRejectedProvider = [...result.providerStats].sort((left, right) => right.rejected429 - left.rejected429)[0];

  if (mostRejectedProvider && mostRejectedProvider.rejected429 > 0) {
    observations.push(
      `${mostRejectedProvider.provider} saw the highest 429 volume at ${mostRejectedProvider.rejected429} rejections (${mostRejectedProvider.rejectionRatePct.toFixed(1)}%).`,
    );
  }

  if (result.summary.fallbackActivations > 0) {
    observations.push(`Fallback paths activated ${result.summary.fallbackActivations} times across the run.`);
  }

  if (result.summary.maxQueueDepth > 0) {
    observations.push(`Queue-and-delay behavior reached a max queue depth of ${result.summary.maxQueueDepth}.`);
  }

  if (result.summary.recoveryTimeMs !== undefined) {
    observations.push(`Recovery after the simulated outage completed in ${(result.summary.recoveryTimeMs / 1_000).toFixed(1)}s.`);
  }

  if (result.summary.executionPriorityStarvationEvents > 0) {
    observations.push('Execution-sensitive traffic starved at least once; this should block rollout.');
  }

  return observations;
}

async function settleSimulation(tasks: Promise<void>[], clock: VirtualClock): Promise<void> {
  let pending = tasks.length;
  const failures: unknown[] = [];

  for (const task of tasks) {
    void task.then(
      () => {
        pending -= 1;
      },
      (error) => {
        pending -= 1;
        failures.push(error);
      },
    );
  }

  await flushMicrotasks();

  while (pending > 0) {
    const advanced = await clock.advanceToNextEvent();
    await flushMicrotasks();

    if (!advanced && pending > 0) {
      const reason = failures[0] instanceof Error ? failures[0].message : 'Simulation deadlocked without any pending clock events.';
      throw new Error(reason);
    }
  }

  if (failures.length > 0) {
    throw failures[0] instanceof Error ? failures[0] : new Error(String(failures[0]));
  }
}

export async function runScenario(scenario: ScenarioConfig, options: RunnerOptions = {}): Promise<ScenarioRunResult> {
  const clock = new VirtualClock();
  const coordinator = options.coordinator ?? createSharedRateBudgetCoordinator({ clock });
  const random = createDeterministicRandom(options.seed ?? `${scenario.id}:${scenario.name}`);
  const providers = new Map(
    scenario.providers.map((providerConfig) => [providerConfig.name, new MockProvider(providerConfig, coordinator, clock, random)]),
  );

  const providerState = new Map<string, MutableProviderState>();
  const agentState = new Map<string, MutableAgentState>();
  const lastSuccessfulRefresh = new Map<string, Map<DataCategory, number>>();
  const maxStalenessByCategory = new Map<DataCategory, number>([
    ['execution', 0],
    ['price', 0],
    ['regime', 0],
    ['discovery', 0],
    ['enrichment', 0],
  ]);
  const recoveryWindows: OutageRecoveryState[] = scenario.providers.flatMap((provider) =>
    (provider.outageWindows ?? []).map((window) => ({
      provider: provider.name,
      endMs: window.startMs + window.durationMs,
    })),
  );

  for (const agent of scenario.agents) {
    agentState.set(agent.id, {
      agentId: agent.id,
      role: agent.role,
      callsMade: 0,
      callsAccepted: 0,
      callsRejected: 0,
      fallbackActivations: 0,
      staleDataEvents: 0,
      starvationEvents: 0,
      latenciesMs: [],
      waitTimesMs: [],
    });
    lastSuccessfulRefresh.set(agent.id, new Map());
  }

  for (const provider of scenario.providers) {
    providerState.set(provider.name, {
      attempted: 0,
      accepted: 0,
      rejected429: 0,
      errors5xx: 0,
      fallbackAccepted: 0,
      latenciesMs: [],
      waitTimesMs: [],
    });
  }

  const recordAttempt = (attempt: ProviderAttemptRecord): void => {
    const provider = providerState.get(attempt.provider);
    if (!provider) {
      throw new Error(`Unknown provider ${attempt.provider}`);
    }

    provider.attempted += 1;
    provider.latenciesMs.push(attempt.latencyMs);
    provider.waitTimesMs.push(attempt.waitMs + attempt.queuedMs);
    if (attempt.outcome === 'accepted') {
      provider.accepted += 1;
      if (attempt.viaFallback) {
        provider.fallbackAccepted += 1;
      }
    } else if (attempt.outcome === 'rejected_429') {
      provider.rejected429 += 1;
    } else {
      provider.errors5xx += 1;
    }

    const recoveryWindow = recoveryWindows.find(
      (window) => window.provider === attempt.provider && window.recoveredAtMs === undefined && attempt.atMs >= window.endMs,
    );
    if (recoveryWindow && attempt.outcome === 'accepted' && !attempt.viaFallback) {
      recoveryWindow.recoveredAtMs = attempt.atMs;
    }
  };

  const executeLogicalRequest = async (
    agentId: string,
    category: DataCategory,
    requestClass: ProviderAttemptRecord['requestClass'],
    providerName: string,
    fallbackProviders: string[],
  ): Promise<LogicalRequestOutcome> => {
    const agent = agentState.get(agentId);
    if (!agent) {
      throw new Error(`Unknown agent ${agentId}`);
    }

    agent.callsMade += 1;
    const startedAtMs = clock.now();
    const providersToTry = [providerName, ...fallbackProviders];

    for (let index = 0; index < providersToTry.length; index += 1) {
      const candidateProvider = providers.get(providersToTry[index] ?? '');
      if (!candidateProvider) {
        throw new Error(`Scenario references unknown provider ${providersToTry[index]}`);
      }

      const attempt = await candidateProvider.request({
        agentId,
        requestClass,
        category,
        viaFallback: index > 0,
      });
      recordAttempt(attempt);

      if (attempt.outcome === 'accepted') {
        agent.callsAccepted += 1;
        agent.latenciesMs.push(clock.now() - startedAtMs);
        agent.waitTimesMs.push(attempt.waitMs + attempt.queuedMs);

        const categoryMap = lastSuccessfulRefresh.get(agentId);
        categoryMap?.set(category, clock.now());

        if (index > 0) {
          agent.fallbackActivations += 1;
        }

        return {
          accepted: true,
          latencyMs: clock.now() - startedAtMs,
          usedFallback: index > 0,
        };
      }
    }

    agent.callsRejected += 1;
    const categoryMap = lastSuccessfulRefresh.get(agentId);
    const lastSuccess = categoryMap?.get(category);
    if (lastSuccess !== undefined) {
      const ageMs = clock.now() - lastSuccess;
      const currentMax = maxStalenessByCategory.get(category) ?? 0;
      maxStalenessByCategory.set(category, Math.max(currentMax, ageMs));
      agent.staleDataEvents += 1;
    }

    if (isExecutionSensitive(category)) {
      agent.starvationEvents += 1;
    }

    return {
      accepted: false,
      latencyMs: clock.now() - startedAtMs,
      usedFallback: false,
    };
  };

  const tasks = scenario.agents.map(async (agent) => {
    if (agent.startOffsetMs && agent.startOffsetMs > 0) {
      await clock.sleep(agent.startOffsetMs);
    }

    for (let tickIndex = 0; tickIndex < agent.tickCount; tickIndex += 1) {
      if (tickIndex > 0) {
        await clock.sleep(agent.tickIntervalMs);
      }

      const tickRequests: Promise<LogicalRequestOutcome>[] = [];
      for (const request of agent.requestsPerTick) {
        for (let count = 0; count < request.count; count += 1) {
          tickRequests.push(
            executeLogicalRequest(
              agent.id,
              request.category,
              request.requestClass,
              request.provider,
              request.fallbackProviders ?? [],
            ),
          );
        }
      }

      await Promise.all(tickRequests);
    }
  });

  await settleSimulation(tasks, clock);

  for (const [agentId, categoryMap] of lastSuccessfulRefresh.entries()) {
    const agent = agentState.get(agentId);
    if (!agent) {
      continue;
    }

    for (const [category, lastSuccess] of categoryMap.entries()) {
      const ageMs = Math.max(0, clock.now() - lastSuccess);
      maxStalenessByCategory.set(category, Math.max(maxStalenessByCategory.get(category) ?? 0, ageMs));
    }
  }

  const finalProviderStats = [...providerState.entries()].map(([provider, state]) => {
    const mockProvider = providers.get(provider);
    return toProviderStats(provider, state, mockProvider?.getMaxQueuedRequests() ?? 0);
  });
  const finalAgentStats = [...agentState.values()].map(toAgentStats);
  const totalRequestsAttempted = finalProviderStats.reduce((sum, provider) => sum + provider.attempted, 0);
  const totalRequestsAccepted = finalProviderStats.reduce((sum, provider) => sum + provider.accepted, 0);
  const totalRequestsRejected429 = finalProviderStats.reduce((sum, provider) => sum + provider.rejected429, 0);
  const totalErrors5xx = finalProviderStats.reduce((sum, provider) => sum + provider.errors5xx, 0);
  const fallbackActivations = finalAgentStats.reduce((sum, agent) => sum + agent.fallbackActivations, 0);
  const executionPriorityStarvationEvents = finalAgentStats.reduce((sum, agent) => sum + agent.starvationEvents, 0);
  const maxProviderRejectionRatePct = finalProviderStats.reduce((max, provider) => Math.max(max, provider.rejectionRatePct), 0);
  const maxQueueDepth = finalProviderStats.reduce((max, provider) => Math.max(max, provider.maxQueueDepth), 0);
  const averageAcceptedCalls = finalAgentStats.length > 0 ? totalRequestsAccepted / finalAgentStats.length : 0;
  const fairShareDeviationPct = averageAcceptedCalls === 0
    ? 0
    : finalAgentStats.reduce(
      (max, agent) => Math.max(max, Math.abs(agent.callsAccepted - averageAcceptedCalls) / averageAcceptedCalls * 100),
      0,
    );
  const recoveredDurations = recoveryWindows
    .filter((window) => window.recoveredAtMs !== undefined)
    .map((window) => (window.recoveredAtMs ?? window.endMs) - window.endMs);
  const recoveryTimeMs = recoveredDurations.length > 0 ? Math.max(...recoveredDurations) : undefined;

  const provisionalResult: ScenarioRunResult = {
    scenario,
    runDateIso: new Date().toISOString(),
    simulatedDurationMs: Math.max(scenario.durationMs, clock.now()),
    providerStats: finalProviderStats,
    agentStats: finalAgentStats,
    summary: {
      totalRequestsAttempted,
      totalRequestsAccepted,
      totalRequestsRejected429,
      totalErrors5xx,
      executionPriorityStarvationEvents,
      maxPriceStalenessMs: maxStalenessByCategory.get('price') ?? 0,
      maxDiscoveryStalenessMs: maxStalenessByCategory.get('discovery') ?? 0,
      fallbackActivations,
      recoveryTimeMs,
      fairShareDeviationPct,
      maxProviderRejectionRatePct,
      maxQueueDepth,
    },
    thresholdChecks: [],
    observations: [],
    verdict: 'PASS',
    verdictReason: '',
  };

  provisionalResult.thresholdChecks = computeThresholdChecks(provisionalResult);
  provisionalResult.observations = buildObservations(provisionalResult);
  const verdict = computeVerdict(provisionalResult.summary, provisionalResult.thresholdChecks);
  provisionalResult.verdict = verdict.verdict;
  provisionalResult.verdictReason = verdict.reason;
  return provisionalResult;
}