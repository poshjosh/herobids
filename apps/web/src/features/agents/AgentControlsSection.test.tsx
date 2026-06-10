import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { describe, expect, it } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import { AgentControlsSection, type AgentControlsFormValue } from './AgentControlsSection.js';

function renderControls(value: Partial<AgentControlsFormValue> = {}): string {
  const state: AgentControlsFormValue = {
    costPreset: 'standard',
    dailySpendBudgetUsd: '',
    tickIntervalMs: '',
    maxBots: '',
    capital: '',
    dailyLossLimit: '',
    maxSlippageBps: '',
    dailyLlmTokenBudget: '',
    ...value,
  };

  return renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages}>
      <AgentControlsSection value={state} onChange={() => undefined} />
    </IntlProvider>,
  );
}

describe('AgentControlsSection rendering', () => {
  it('renders preset, spend budget, capital, and token budget labels', () => {
    const html = renderControls();
    expect(html).toContain(messages['agents.controls.costPreset']);
    expect(html).toContain(messages['agents.controls.dailySpendBudget']);
    expect(html).toContain(messages['agents.controls.capital']);
    expect(html).toContain(messages['agents.controls.dailyLlmTokenBudget']);
  });

  it('shows preset-derived cadence and daily spend when no explicit tick interval exists', () => {
    const html = renderControls({ costPreset: 'minimal' });
    expect(html).toContain('Expected cadence: every 30 min');
    expect(html).toContain('Estimated daily LLM spend: ~$3.00');
  });

  it('shows explicit cadence override messaging when tick interval is set', () => {
    const html = renderControls({ costPreset: 'premium', tickIntervalMs: '600000' });
    expect(html).toContain('Base cadence: every 10 min');
    expect(html).toContain('Estimated daily LLM spend: ~$7.20');
  });
});