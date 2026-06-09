import type { AgentStats, MetricStatus, ProviderStats, ScenarioRunResult, ScenarioVerdict, ThresholdCheck } from './types.js';

function formatDurationSeconds(durationMs: number | undefined): string {
  if (durationMs === undefined) {
    return 'N/A';
  }
  return `${(durationMs / 1_000).toFixed(durationMs >= 10_000 ? 0 : 1)}s`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function formatStatus(status: MetricStatus): string {
  switch (status) {
    case 'PASS':
      return 'PASS';
    case 'FAIL':
      return 'FAIL';
    case 'WARN':
      return 'WARN';
    case 'N/A':
      return 'N/A';
  }
}

function formatVerdict(verdict: ScenarioVerdict): string {
  switch (verdict) {
    case 'PASS':
      return 'PASS';
    case 'FAIL':
      return 'FAIL';
    case 'DEGRADED':
      return 'DEGRADED';
  }
}

function renderProviderConfig(provider: ProviderStats): string {
  return `${provider.provider}: attempted ${provider.attempted}, accepted ${provider.accepted}, rejected ${provider.rejected429}, avg latency ${provider.averageLatencyMs.toFixed(1)}ms`;
}

function renderThresholdTable(thresholdChecks: ThresholdCheck[]): string {
  if (thresholdChecks.length === 0) {
    return 'No explicit threshold checks were defined for this scenario.';
  }

  const rows = thresholdChecks.map((check) => `| ${check.metric} | ${check.value} | ${check.target} | ${formatStatus(check.status)} |`);
  return [
    '| Metric | Value | Target | Status |',
    '|---|---|---|---|',
    ...rows,
  ].join('\n');
}

function renderAgentRow(agent: AgentStats): string {
  return `| ${agent.agentId} | ${agent.callsMade} | ${agent.callsAccepted} | ${agent.callsRejected} | ${agent.staleDataEvents} | ${agent.starvationEvents} | ${agent.p50LatencyMs.toFixed(1)} | ${agent.p95LatencyMs.toFixed(1)} | ${agent.maxWaitMs.toFixed(1)} |`;
}

function renderProviderRow(provider: ProviderStats): string {
  return `| ${provider.provider} | ${provider.attempted} | ${provider.accepted} | ${provider.rejected429} | ${provider.errors5xx} | ${formatPercent(provider.rejectionRatePct)} | ${provider.averageLatencyMs.toFixed(1)}ms | ${provider.p95LatencyMs.toFixed(1)}ms | ${provider.maxQueueDepth} |`;
}

export function renderMarkdownReport(result: ScenarioRunResult): string {
  const { scenario, summary } = result;
  const providerLines = result.providerStats.map(renderProviderConfig).join('; ');
  const observations = result.observations.length > 0 ? result.observations.map((entry) => `- ${entry}`).join('\n') : '- No anomalies observed.';

  return [
    '# Rate-Limit Behavior Report',
    '',
    `**Run date:** ${result.runDateIso}`,
    `**Scenario:** ${scenario.id} — ${scenario.name}`,
    `**Duration:** ${formatDurationSeconds(result.simulatedDurationMs)} simulated`,
    `**Agent count:** ${scenario.agents.length}`,
    '**Environment:** local rate-limit lab',
    '**Run by:** local harness',
    '',
    '## Configuration',
    `- Agents: ${scenario.agents.length}`,
    `- Duration: ${formatDurationSeconds(result.simulatedDurationMs)} simulated`,
    `- Providers: ${providerLines}`,
    `- Scenario: ${scenario.id} — ${scenario.description}`,
    '',
    '## Results Summary',
    '| Metric | Value | Status |',
    '|---|---|---|',
    `| Total requests attempted | ${summary.totalRequestsAttempted} | — |`,
    `| Total requests accepted | ${summary.totalRequestsAccepted} | — |`,
    `| Total requests rejected (429) | ${summary.totalRequestsRejected429} | ${summary.totalRequestsRejected429 === 0 ? 'PASS' : 'WARN'} |`,
    `| Total provider errors (5xx) | ${summary.totalErrors5xx} | ${summary.totalErrors5xx === 0 ? 'PASS' : 'WARN'} |`,
    `| Execution-priority starvation events | ${summary.executionPriorityStarvationEvents} | ${summary.executionPriorityStarvationEvents === 0 ? 'PASS' : 'FAIL'} |`,
    `| Max data staleness (prices) | ${formatDurationSeconds(summary.maxPriceStalenessMs)} | ${summary.maxPriceStalenessMs <= 60_000 ? 'PASS' : 'FAIL'} |`,
    `| Max data staleness (discovery) | ${formatDurationSeconds(summary.maxDiscoveryStalenessMs)} | ${summary.maxDiscoveryStalenessMs <= 300_000 ? 'PASS' : 'FAIL'} |`,
    `| Fallback activations | ${summary.fallbackActivations} | — |`,
    `| Recovery time (if applicable) | ${formatDurationSeconds(summary.recoveryTimeMs)} | ${summary.recoveryTimeMs === undefined ? 'N/A' : summary.recoveryTimeMs <= 60_000 ? 'PASS' : 'FAIL'} |`,
    `| Fair share deviation | ${formatPercent(summary.fairShareDeviationPct)} | ${summary.fairShareDeviationPct <= 20 ? 'PASS' : summary.fairShareDeviationPct <= 50 ? 'WARN' : 'FAIL'} |`,
    `| Max provider rejection rate | ${formatPercent(summary.maxProviderRejectionRatePct)} | ${summary.maxProviderRejectionRatePct < 10 ? 'PASS' : summary.maxProviderRejectionRatePct <= 20 ? 'WARN' : 'FAIL'} |`,
    '',
    '## Threshold Checks',
    renderThresholdTable(result.thresholdChecks),
    '',
    '## Per-Provider Breakdown',
    '| Provider | Attempted | Accepted | Rejected | Errors | Rejection rate | Avg latency | p95 latency | Max queue depth |',
    '|---|---|---|---|---|---|---|---|---|',
    ...result.providerStats.map(renderProviderRow),
    '',
    '## Per-Agent Breakdown',
    '| Agent | Calls made | Calls accepted | Calls rejected | Stale data events | Starvation events | p50 latency (ms) | p95 latency (ms) | Max wait (ms) |',
    '|---|---|---|---|---|---|---|---|---|',
    ...result.agentStats.map(renderAgentRow),
    '',
    '## Observations',
    observations,
    '',
    '## Verdict',
    '',
    `${formatVerdict(result.verdict)} — ${result.verdictReason}`,
  ].join('\n');
}