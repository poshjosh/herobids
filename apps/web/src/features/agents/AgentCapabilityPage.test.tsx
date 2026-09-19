import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import type { Agent, CapabilityReadiness } from '../../lib/api-client.js';

const { tradingPresentation } = vi.hoisted(() => ({
  tradingPresentation: vi.fn(() => <div>Trading adapter presentation</div>),
}));

vi.mock('../../lib/api-client.js', () => ({
  agents: {
    get: vi.fn(),
    capabilityReadiness: vi.fn(),
    tradingConnections: vi.fn(),
    update: vi.fn(),
  },
  capabilities: {
    tradingConnections: vi.fn(),
  },
}));

vi.mock('./TradingCapabilityPresentation.js', () => ({
  TradingCapabilityPresentation: tradingPresentation,
}));

import { AgentCapabilityPage } from './AgentCapabilityPage.js';

function makeAgent(): Agent {
  return {
    id: 'agent-1',
    userId: 'user-1',
    name: 'Trading agent',
    prompt: 'Trade carefully',
    skillIds: ['trading-skill'],
    status: 'stopped',
    pauseState: null,
    toolPolicy: null,
    modelPolicy: null,
    provider: null,
    lightModel: null,
    heavyModel: null,
    costPreset: null,
    dailySpendBudgetUsd: null,
    dailyLlmTokenBudget: null,
    risk: null,
    strategy: null,
    executionDefaults: null,
    telegramChatId: null,
    executionMode: null,
    dailyLossLimit: null,
    maxDrawdownPct: null,
    maxBots: null,
    maxSlippageBps: null,
    maxOpenPositions: null,
    maxPositionSizePct: null,
    stopLossPct: null,
    stopLossCooldownMs: null,
    tickIntervalMs: null,
    capital: null,
    style: null,
    runtimePolicyOverrides: null,
    resolvedRuntimePolicy: null,
    openPositionEscalationToJudgePolicy: null,
    technical: null,
    strategyPreset: null,
    strategyPresetName: null,
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
  };
}

function renderUnreadyTradingCapability(): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const readiness: CapabilityReadiness = {
    family: 'trading',
    state: 'unconfigured',
    connectionReadiness: 'unconfigured',
    agentEligibility: 'eligible',
    effectiveReady: false,
    reasons: ['A trading connection must be selected.'],
  };

  queryClient.setQueryData(['agents', 'agent-1'], makeAgent());
  queryClient.setQueryData(['agents', 'agent-1', 'capabilities', 'trading'], readiness);

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages}>
        <MemoryRouter initialEntries={['/agents/agent-1/capabilities/trading']}>
          <Routes>
            <Route path="/agents/:agentId/capabilities/:family" element={<AgentCapabilityPage />} />
          </Routes>
        </MemoryRouter>
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('AgentCapabilityPage', () => {
  it('does not mount trading adapter presentation until the selected connection is ready', () => {
    const html = renderUnreadyTradingCapability();

    expect(html).toContain(messages['agents.summary.capabilityUnavailable']);
    expect(html).toContain(messages['agents.capabilityPage.tradingUnavailable']);
    expect(html).not.toContain('Trading adapter presentation');
    expect(tradingPresentation).not.toHaveBeenCalled();
  });
});