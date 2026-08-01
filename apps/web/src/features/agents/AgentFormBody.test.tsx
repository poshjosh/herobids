import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IntlProvider } from 'react-intl';
import { describe, expect, it } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import type { AgentFormState } from './agent-form-state.js';
import { AgentFormBody } from './AgentFormBody.js';
import { defaultTechnicalConfigFormState } from './technical-config-helpers.js';

const BASE_FORM_STATE: AgentFormState = {
  name: '',
  goal: '',
  capabilityMode: 'intelligence',
  hybridMode: undefined,
  technicalPreFilterEnabled: false,
  technicalConfig: defaultTechnicalConfigFormState(),
  skillIds: [],
  connectionIds: [],
  executionMode: '',
  capital: '',
  telegramChatId: '',
  emailDelivery: 'inherit',
  costPreset: '',
  dailySpendBudgetUsd: '',
  tickIntervalMins: '',
  dailyLossLimit: '',
  maxDrawdownPct: '',
  maxSlippageBps: '',
  maxOpenPositions: '',
  maxPositionSizePct: '',
  stopLossPct: '',
  stopLossCooldownSecs: '',
  openPositionEscalationToJudgePolicy: 'uncovered_or_triggered',
  strategyPreset: '',
  platformAssessmentEnabled: false,
  platformAssessmentReviewIntervalHours: '',
  subscribedSources: [],
  pendingFiles: [],
  authorizationMode: 'direct',
};

function renderBody(overrides: Partial<Parameters<typeof AgentFormBody>[0]> = {}): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages}>
        <AgentFormBody
          value={BASE_FORM_STATE}
          onChange={() => undefined}
          showIntelligence
          showTradingControls={false}
          requiresTradingSetup={false}
          isAdmin={false}
          selectableSkills={[]}
          skillsLoading={false}
          skillsError={null}
          formErrors={{}}
          onClearFieldError={() => undefined}
          onBlurField={() => undefined}
          validationConstraints={{
            maxOpenPositions: 10,
            maxPositionSizePct: 100,
            stopLossMaxUnrealizedLossPct: 100,
          }}
          tickIntervalError={null}
          modelSlot={<div>Model slot</div>}
          connectionSlot={<div>Connection slot marker</div>}
          computeBudgetSlot={null}
          subscribedSources={[]}
          onSubscribedSourcesChange={() => undefined}
          {...overrides}
        />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('AgentFormBody', () => {
  it('renders the connection slot for non-trading agents', () => {
    const html = renderBody();

    expect(html).toContain('Connection slot marker');
  });
});