// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IntlProvider } from 'react-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import type { Agent } from '../../lib/api-client.js';

vi.mock('../../lib/api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api-client.js')>();
  return {
    ...actual,
    agents: {
      ...actual.agents,
      update: vi.fn().mockResolvedValue({}),
      riskDefaults: vi.fn().mockResolvedValue({}),
      capabilityReadiness: vi.fn().mockResolvedValue(null),
      tradingConnections: vi.fn().mockResolvedValue({ connections: [] }),
      getConnections: vi.fn().mockResolvedValue({ connections: [] }),
      listDocuments: vi.fn().mockResolvedValue({ documents: [] }),
    },
    skills: { ...actual.skills, list: vi.fn().mockResolvedValue({ skills: [] }) },
    auth: { ...actual.auth, me: vi.fn().mockResolvedValue({ id: 'user-1', isAdmin: false, email: 'a@example.com', chatAddresses: [] }) },
    ai: {
      ...actual.ai,
      settings: vi.fn(),
      availableModels: vi.fn().mockResolvedValue({ providers: [] }),
    },
    capabilities: { ...actual.capabilities, tradingConnections: vi.fn().mockResolvedValue({ connections: [] }) },
    connections: { ...actual.connections, list: vi.fn().mockResolvedValue({ connections: [] }) },
    providerCatalog: { ...actual.providerCatalog, get: vi.fn().mockResolvedValue({ providers: [] }) },
  };
});
vi.mock('../notifications/NotificationsBlock.js', () => ({ NotificationsBlock: () => null }));

import { ai } from '../../lib/api-client.js';
import { EditAgentModal } from './EditAgentModal.js';

function text(id: string): string {
  const value = messages[id];
  if (value === undefined) throw new Error(`Missing test message: ${id}`);
  return value;
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-123',
    userId: 'user-1',
    name: 'Research agent',
    prompt: 'Summarise the news every day.',
    skillIds: [],
    status: 'stopped',
    pauseState: null,
    toolPolicy: null,
    modelPolicy: null,
    provider: 'openrouter',
    lightModel: 'xiaomi/mimo-v2.6-flash',
    heavyModel: 'anthropic/claude-haiku-5.5',
    costPreset: 'standard',
    dailySpendBudgetUsd: null,
    dailyLlmTokenBudget: null,
    chatAddresses: [],
    executionMode: 'paper',
    maxBots: null,
    tickIntervalMs: null,
    technical: null,
    strategyPreset: null,
    strategyPresetName: null,
    style: 'balanced',
    runtimePolicyOverrides: null,
    resolvedRuntimePolicy: null,
    openPositionEscalationToJudgePolicy: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as unknown as Agent;
}

function renderModal(agent: Agent) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages}>
        <EditAgentModal agentId="agent-123" onClose={vi.fn()} initialData={agent} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

function reasoningSelect(labelId: string): HTMLSelectElement {
  return screen.getByRole('combobox', { name: text(labelId), hidden: true }) as HTMLSelectElement;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('EditAgentModal reasoning defaults and model output warning', () => {
  it('shows the agent style default reasoning, not the saved AI settings level, when the agent has no level', async () => {
    vi.mocked(ai.settings).mockResolvedValue({
      aiModelConfig: {
        provider: 'openrouter',
        lightModel: 'xiaomi/mimo-v2.6-flash',
        heavyModel: 'anthropic/claude-haiku-5.5',
        scoutReasoning: 'medium',
        judgeReasoning: 'high',
        adaptScoutReasoning: null,
        adaptJudgeReasoning: null,
      },
    });
    renderModal(makeAgent({ style: 'careful' }));
    await waitFor(() => expect(ai.settings).toHaveBeenCalled());

    const scout = reasoningSelect('agents.edit.models.reasoning.scoutLabel');
    const judge = reasoningSelect('agents.edit.models.reasoning.judgeLabel');
    expect(scout.value).toBe('');
    expect(scout.options[0]!.textContent).toBe('Style default (None)');
    expect(judge.value).toBe('');
    expect(judge.options[0]!.textContent).toBe('Style default (Low)');
  });

  it('keeps an explicit agent reasoning level selected', () => {
    vi.mocked(ai.settings).mockResolvedValue({ aiModelConfig: null });
    renderModal(makeAgent({ runtimePolicyOverrides: { judgeReasoning: 'high' } as Agent['runtimePolicyOverrides'] }));

    expect(reasoningSelect('agents.edit.models.reasoning.judgeLabel').value).toBe('high');
  });

  it('warns when the agent premium model cannot fit the bold style default judge level (high)', () => {
    vi.mocked(ai.settings).mockResolvedValue({ aiModelConfig: null });
    renderModal(makeAgent({ style: 'bold', heavyModel: 'anthropic/claude-opus-4' }));

    const warning = screen.getByTestId('model-output-limit-warning-judge');
    expect(warning.textContent).toContain('at most 32,000 tokens');
    expect(warning.textContent).toContain(`The ${text('agents.style.bold.label')} style at ${text('aiModels.reasoning.high')} reasoning may need 49,152`);
  });

  it('does not warn when the agent judge level is low on the bold style', () => {
    vi.mocked(ai.settings).mockResolvedValue({ aiModelConfig: null });
    renderModal(makeAgent({
      style: 'bold',
      heavyModel: 'anthropic/claude-opus-4',
      runtimePolicyOverrides: { judgeReasoning: 'low' } as Agent['runtimePolicyOverrides'],
    }));

    expect(screen.queryByTestId('model-output-limit-warning-judge')).toBeNull();
  });

  it('warns about the platform default premium model when neither the agent nor AI settings set one', async () => {
    vi.mocked(ai.settings).mockResolvedValue({ aiModelConfig: null });
    vi.mocked(ai.availableModels).mockResolvedValue({
      providers: [],
      defaults: { provider: 'openrouter', lightModel: 'xiaomi/mimo-v2.6-flash', heavyModel: 'anthropic/claude-opus-4' },
    });
    renderModal(makeAgent({ style: 'bold', provider: null, lightModel: null, heavyModel: null }));

    expect(await screen.findByTestId('model-output-limit-warning-judge')).toBeTruthy();
  });

  it('warns about the inherited premium model when the agent has no model override', async () => {
    vi.mocked(ai.settings).mockResolvedValue({
      aiModelConfig: {
        provider: 'openrouter',
        lightModel: 'xiaomi/mimo-v2.6-flash',
        heavyModel: 'anthropic/claude-opus-4',
        scoutReasoning: null,
        judgeReasoning: null,
        adaptScoutReasoning: null,
        adaptJudgeReasoning: null,
      },
    });
    renderModal(makeAgent({ style: 'bold', provider: null, lightModel: null, heavyModel: null }));

    expect(await screen.findByTestId('model-output-limit-warning-judge')).toBeTruthy();
  });

  it('shows no warning for the default models on the bold style', async () => {
    vi.mocked(ai.settings).mockResolvedValue({ aiModelConfig: null });
    renderModal(makeAgent({ style: 'bold' }));
    await waitFor(() => expect(ai.settings).toHaveBeenCalled());

    expect(screen.queryByTestId('model-output-limit-warning-judge')).toBeNull();
    expect(screen.queryByTestId('model-output-limit-warning-scout')).toBeNull();
  });
});
