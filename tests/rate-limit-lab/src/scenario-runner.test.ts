import { describe, expect, it } from 'vitest';
import { renderMarkdownReport } from './report.js';
import { runScenario } from './scenario-runner.js';
import { getScenarioConfig } from './scenarios.js';

describe('rate-limit lab harness', () => {
  it('encodes Scenario B threshold checks and keeps execution traffic unstaved', async () => {
    const result = await runScenario(getScenarioConfig('B'), { seed: 'scenario-b-test' });

    expect(result.summary.executionPriorityStarvationEvents).toBe(0);
    expect(result.summary.maxPriceStalenessMs).toBeLessThanOrEqual(60_000);
    expect(result.summary.maxDiscoveryStalenessMs).toBeLessThanOrEqual(300_000);
    expect(result.summary.maxProviderRejectionRatePct).toBeLessThan(10);
    expect(result.thresholdChecks.every((check) => check.status === 'PASS' || check.status === 'N/A')).toBe(true);
    expect(result.verdict).toBe('PASS');
  });

  it('renders the documented report sections and records Scenario E priority protection', async () => {
    const result = await runScenario(getScenarioConfig('E'), { seed: 'scenario-e-test' });
    const markdown = renderMarkdownReport(result);

    expect(result.summary.executionPriorityStarvationEvents).toBe(0);
    expect(result.summary.totalRequestsRejected429).toBeGreaterThan(0);
    expect(markdown).toContain('# Rate-Limit Behavior Report');
    expect(markdown).toContain('## Configuration');
    expect(markdown).toContain('## Results Summary');
    expect(markdown).toContain('## Per-Provider Breakdown');
    expect(markdown).toContain('## Per-Agent Breakdown');
    expect(markdown).toContain('## Observations');
    expect(markdown).toContain('## Verdict');
  });
});