import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import type { CapabilityReadiness } from '../../lib/api-client.js';
import { EditAgentModal } from './EditAgentModal.js';

function renderModal(options: {
  capabilityReadiness?: CapabilityReadiness;
  capital?: string;
  dailyLossLimit?: string;
  maxSlippageBps?: number | '';
} = {}): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  if (options.capabilityReadiness) {
    queryClient.setQueryData(['agents', 'agent-123', 'capability-readiness', 'trading'], options.capabilityReadiness);
  }

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages}>
        <EditAgentModal
          agentId="agent-123"
          onClose={() => undefined}
          initialData={{
            id: 'agent-123',
            userId: 'user-1',
            name: 'Momentum scout',
            prompt: 'Watch BTC and trade breakouts.',
            skillIds: [],
            status: 'stopped',
            pauseState: null,
            toolPolicy: null,
            modelPolicy: null,
            provider: null,
            lightModel: null,
            heavyModel: null,
            costPreset: 'custom',
            dailySpendBudgetUsd: 0.5,
            dailyLlmTokenBudget: 45000,
            telegramChatId: null,
            executionMode: 'paper',
            dailyTokenBudget: 45000,
            dailyLossLimit: options.dailyLossLimit ?? '250',
            maxBots: 2,
            maxSlippageBps: options.maxSlippageBps === '' ? null : (options.maxSlippageBps ?? 25),
            tickIntervalMs: null,
            capital: options.capital ?? '1500',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }}
        />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('EditAgentModal rendering', () => {
  it('renders the shared controls and derived summaries for existing values', () => {
    const html = renderModal({
      capabilityReadiness: {
        family: 'trading',
        state: 'ready',
        bindingReadiness: 'ready',
        agentEligibility: 'eligible',
        effectiveReady: true,
        bindingId: 'binding-1',
        reasons: [],
      },
    });
    expect(html).toContain(messages['agents.controls.costPreset']);
    expect(html).toContain(messages['agents.controls.dailySpendBudget']);
    expect(html).toContain(messages['agents.controls.capital.help']);
    expect(html).toContain('Expected cadence: every 6 min');
    expect(html).toContain('Estimated daily LLM spend: ~$0.50');
    expect(html).toContain('value="1500"');
    expect(html).not.toContain(messages['agents.controls.dailyLlmTokenBudget']);
  });

  it('keeps the trading guardrails visible when capability readiness is already cached', () => {
    const html = renderModal({
      capabilityReadiness: {
        family: 'trading',
        state: 'ready',
        bindingReadiness: 'ready',
        agentEligibility: 'eligible',
        effectiveReady: true,
        bindingId: 'binding-1',
        reasons: [],
      },
    });

    expect(html).toContain(messages['agents.create.tradingControls.title']);
    expect(html).toContain(messages['agents.controls.capital']);
    expect(html).toContain(messages['agents.controls.maxSlippage']);
  });

  it('hides the trading guardrails until capability readiness is loaded when no trading values are set', () => {
    const html = renderModal({
      capital: '',
      dailyLossLimit: '',
      maxSlippageBps: '',
    });

    expect(html).not.toContain(messages['agents.create.tradingControls.title']);
    expect(html).not.toContain(messages['agents.controls.capital']);
    expect(html).not.toContain(messages['agents.controls.maxSlippage']);
  });
});
