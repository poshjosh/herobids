import { describe, expect, it } from 'vitest';
import { renderMarkdownReport } from './report.js';
import { runScenario } from './scenario-runner.js';
import { getScenarioConfig } from './scenarios.js';

describe('rate-limit lab report rendering', () => {
  it('renders the documented report sections for scenario B', async () => {
    const result = await runScenario(getScenarioConfig('B'), { seed: 'scenario-b-report' });
    const markdown = renderMarkdownReport(result);

    expect(markdown).toContain('# Rate-Limit Behavior Report');
    expect(markdown).toContain('## Configuration');
    expect(markdown).toContain('## Results Summary');
    expect(markdown).toContain('## Threshold Checks');
    expect(markdown).toContain('## Per-Provider Breakdown');
    expect(markdown).toContain('## Per-Agent Breakdown');
    expect(markdown).toContain('## Observations');
    expect(markdown).toContain('## Verdict');
  });
});