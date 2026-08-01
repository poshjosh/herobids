import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { describe, expect, it } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import { AgentControlsSection, TradingGuardrailsFields, type AgentControlsFormValue, type TradingGuardrailsFormValue } from './AgentControlsSection.js';

const EMPTY_GUARDRAILS: TradingGuardrailsFormValue = {
  dailyMaxLossPct: '',
  maxSlippageBps: '',
  maxOpenPositions: '',
  maxPositionSizePct: '',
  stopLossPct: '',
  stopLossCooldownSecs: '',
  openPositionEscalationToJudgePolicy: 'uncovered_or_triggered',
};

function renderControls(value: Partial<AgentControlsFormValue> = {}): string {
  const state: AgentControlsFormValue = {
    costPreset: 'standard',
    dailySpendBudgetUsd: '',
    tickIntervalMins: '',
    dailyMaxLossPct: '',
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
  it('renders preset and spend budget', () => {
    const html = renderControls();
    expect(html).toContain(messages['agents.controls.costPreset']);
    expect(html).toContain(messages['agents.controls.dailySpendBudget']);
    expect(html).not.toContain(messages['agents.controls.dailyLlmTokenBudget']);
  });

  it('shows preset-derived cadence and daily spend when no explicit tick interval exists', () => {
    const html = renderControls({ costPreset: 'minimal' });
    expect(html).toContain('Expected cadence: every 90 min');
    expect(html).toContain('Estimated daily LLM spend: ~$3.00');
  });

  it('shows explicit cadence override messaging when tick interval is set', () => {
    const html = renderControls({ costPreset: 'premium', tickIntervalMins: '10' });
    expect(html).toContain('Base cadence: every 10 min');
    expect(html).toContain('Estimated daily LLM spend: ~$21.60');
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

  // --- openPositionEscalationToJudgePolicy ---

  it('renders the open position escalation policy dropdown with all three options', () => {
    const html = renderToStaticMarkup(
      <IntlProvider locale="en" messages={messages}>
        <TradingGuardrailsFields value={EMPTY_GUARDRAILS} onChange={() => undefined} />
      </IntlProvider>,
    );
    expect(html).toContain(messages['agents.controls.openPositionEscalationPolicy.never']);
    expect(html).toContain(messages['agents.controls.openPositionEscalationPolicy.uncovered_or_triggered']);
    expect(html).toContain(messages['agents.controls.openPositionEscalationPolicy.always']);
  });

  it('renders the dropdown with the correct data-field attribute', () => {
    const html = renderToStaticMarkup(
      <IntlProvider locale="en" messages={messages}>
        <TradingGuardrailsFields value={EMPTY_GUARDRAILS} onChange={() => undefined} />
      </IntlProvider>,
    );
    expect(html).toContain('data-field="openPositionEscalationToJudgePolicy"');
  });

  it('renders the dropdown with the escalation policy label', () => {
    const html = renderToStaticMarkup(
      <IntlProvider locale="en" messages={messages}>
        <TradingGuardrailsFields value={EMPTY_GUARDRAILS} onChange={() => undefined} />
      </IntlProvider>,
    );
    expect(html).toContain(messages['agents.controls.openPositionEscalationPolicy']);
  });
});