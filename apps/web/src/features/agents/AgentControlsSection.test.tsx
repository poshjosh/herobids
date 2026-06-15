import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { describe, expect, it } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import { AgentControlsSection, TradingGuardrailsFields, type AgentControlsFormValue, type TradingGuardrailsFormValue } from './AgentControlsSection.js';

const EMPTY_GUARDRAILS: TradingGuardrailsFormValue = {
  capital: '',
  dailyLossLimit: '',
  maxSlippageBps: '',
  maxOpenPositions: '',
  maxPositionSizePct: '',
  stopLossPct: '',
  stopLossCooldownSecs: '',
};

function renderControls(value: Partial<AgentControlsFormValue> = {}): string {
  const state: AgentControlsFormValue = {
    costPreset: 'standard',
    dailySpendBudgetUsd: '',
    tickIntervalMins: '',
    maxBots: '',
    capital: '',
    dailyLossLimit: '',
    maxSlippageBps: '',
    maxOpenPositions: '',
    maxPositionSizePct: '',
    stopLossPct: '',
    stopLossCooldownSecs: '',
    ...value,
  };

  return renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages}>
      <AgentControlsSection value={state} onChange={() => undefined} showBotControls />
    </IntlProvider>,
  );
}

describe('AgentControlsSection rendering', () => {
  it('renders preset, spend budget, and max bots labels', () => {
    const html = renderControls();
    expect(html).toContain(messages['agents.controls.costPreset']);
    expect(html).toContain(messages['agents.controls.dailySpendBudget']);
    expect(html).toContain(messages['agents.controls.maxBots']);
    expect(html).not.toContain(messages['agents.controls.dailyLlmTokenBudget']);
  });

  it('hides max bots when bot controls are disabled', () => {
    const html = renderToStaticMarkup(
      <IntlProvider locale="en" messages={messages}>
        <AgentControlsSection
          value={{
            costPreset: 'standard',
            dailySpendBudgetUsd: '',
            tickIntervalMins: '',
            maxBots: '',
            capital: '',
            dailyLossLimit: '',
            maxSlippageBps: '',
            maxOpenPositions: '',
            maxPositionSizePct: '',
            stopLossPct: '',
            stopLossCooldownSecs: '',
          }}
          onChange={() => undefined}
          showBotControls={false}
        />
      </IntlProvider>,
    );

    expect(html).not.toContain(messages['agents.controls.maxBots']);
  });

  it('shows preset-derived cadence and daily spend when no explicit tick interval exists', () => {
    const html = renderControls({ costPreset: 'minimal' });
    expect(html).toContain('Expected cadence: every 30 min');
    expect(html).toContain('Estimated daily LLM spend: ~$3.00');
  });

  it('shows explicit cadence override messaging when tick interval is set', () => {
    const html = renderControls({ costPreset: 'premium', tickIntervalMins: '10' });
    expect(html).toContain('Base cadence: every 10 min');
    expect(html).toContain('Estimated daily LLM spend: ~$7.20');
  });

  it('renders maxPositionSizePct guidance explaining it is independent of capital', () => {
    const html = renderToStaticMarkup(
      <IntlProvider locale="en" messages={messages}>
        <TradingGuardrailsFields value={EMPTY_GUARDRAILS} onChange={() => undefined} />
      </IntlProvider>,
    );
    // Verifies that the help text for maxPositionSizePct does NOT imply capital
    // is required — the percentage cap applies regardless of whether capital is set.
    expect(html).toContain(messages['agents.controls.maxPositionSizePct.help']);
    expect(html).toContain('Applies independently of whether capital is set');
  });
});