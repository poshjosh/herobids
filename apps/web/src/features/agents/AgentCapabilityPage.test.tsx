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

function renderCapability(readiness: CapabilityReadiness): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

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

const NO_CONNECTION_READINESS: CapabilityReadiness = {
  family: 'trading',
  state: 'unconfigured',
  connectionReadiness: 'unconfigured',
  agentEligibility: 'eligible',
  effectiveReady: false,
  reasons: ['no connections have been assigned for this capability family'],
};

describe('AgentCapabilityPage', () => {
  it('does not mount trading adapter presentation until the selected connection is ready', () => {
    const html = renderUnreadyTradingCapability();

    expect(html).toContain(messages['agents.summary.capabilityUnavailable']);
    expect(html).toContain(messages['agents.capabilityPage.tradingUnavailable']);
    expect(html).not.toContain('Trading adapter presentation');
    expect(tradingPresentation).not.toHaveBeenCalled();
  });

  it('leads with the plain-language Status headline for an unready trading capability', () => {
    const html = renderCapability(NO_CONNECTION_READINESS);

    expect(html).toContain(messages['agents.capabilityPage.status.noConnectionHeadline']);
    expect(html).toContain(messages['agents.capabilityPage.status.noConnectionReason']);
  });

  it('no longer renders the retired Why-this-state and Next-steps card titles', () => {
    const html = renderCapability(NO_CONNECTION_READINESS);

    // These keys were deleted in plan 002; their former English copy must be gone.
    expect(html).not.toContain('Why this state');
    expect(html).not.toContain('Next steps');
  });

  it('demotes the technical readiness fields into a Details disclosure', () => {
    const html = renderCapability(NO_CONNECTION_READINESS);

    expect(html).toContain('<details');
    expect(html).toContain(messages['agents.capabilityPage.status.detailsToggle']);
    // The connection-readiness KV label survives inside the Details disclosure.
    expect(html).toContain(messages['agents.detail.connectionReadiness']);
  });
});

function renderEmailCapability(readiness: CapabilityReadiness): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  queryClient.setQueryData(['agents', 'agent-1'], makeAgent());
  queryClient.setQueryData(['agents', 'agent-1', 'capabilities', 'email'], readiness);

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages}>
        <MemoryRouter initialEntries={['/agents/agent-1/capabilities/email']}>
          <Routes>
            <Route path="/agents/:agentId/capabilities/:family" element={<AgentCapabilityPage />} />
          </Routes>
        </MemoryRouter>
      </IntlProvider>
    </QueryClientProvider>,
  );
}

const EMAIL_NO_CONNECTION_READINESS: CapabilityReadiness = {
  family: 'email',
  state: 'unconfigured',
  connectionReadiness: 'unconfigured',
  agentEligibility: 'eligible',
  effectiveReady: false,
  reasons: ['no connections have been assigned for this capability family'],
};

describe('AgentCapabilityPage — non-trading (email) family', () => {
  it('renders family-neutral readiness copy and omits trading-specific copy and the trading connections card', () => {
    const html = renderEmailCapability(EMAIL_NO_CONNECTION_READINESS);

    // Neutral, family-agnostic Status copy is shown.
    expect(html).toContain(messages['agents.capabilityPage.status.noConnectionHeadlineGeneric']);
    expect(html).toContain(messages['agents.capabilityPage.status.noConnectionReasonGeneric']);
    expect(html).toContain(messages['agents.capabilityPage.status.action.assignHelperGeneric']);

    // Trading-specific copy must not leak into a non-trading family page.
    expect(html).not.toContain(messages['agents.capabilityPage.status.noConnectionHeadline']);
    expect(html).not.toContain(messages['agents.capabilityPage.status.noConnectionReason']);

    // Non-trading families get the Manage-connections link, never the trading
    // Available-connections card (gated on family === 'trading').
    expect(html).toContain(messages['agents.capabilityPage.manageConnections']);
    expect(html).not.toContain(messages['agents.capabilityPage.availableConnections']);
  });
});

