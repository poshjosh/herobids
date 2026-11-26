// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IntlProvider } from 'react-intl';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import type { AiModelSettings, MeResponse } from '../../lib/api-client.js';

vi.mock('../../lib/api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api-client.js')>();
  return {
    ...actual,
    agents: {
      ...actual.agents,
      create: vi.fn().mockResolvedValue({ id: 'agent-new' }),
      start: vi.fn().mockResolvedValue({}),
      riskDefaults: vi.fn().mockResolvedValue({}),
    },
    auth: { ...actual.auth, me: vi.fn() },
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

import { ai, auth } from '../../lib/api-client.js';
import { CreateAgentFlow } from './CreateAgentFlow.js';

function text(id: string): string {
  const value = messages[id];
  if (value === undefined) throw new Error(`Missing test message: ${id}`);
  return value;
}

function savedSettings(overrides: Partial<AiModelSettings> = {}): { aiModelConfig: AiModelSettings } {
  return {
    aiModelConfig: {
      provider: 'openrouter',
      lightModel: 'xiaomi/mimo-v2.6-flash',
      heavyModel: 'anthropic/claude-haiku-5.5',
      scoutReasoning: null,
      judgeReasoning: null,
      adaptScoutReasoning: null,
      adaptJudgeReasoning: null,
      ...overrides,
    },
  };
}

function renderFlow() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <IntlProvider locale="en" messages={messages}>
          <CreateAgentFlow skills={[]} skillsLoading={false} skillsError={null} onClose={vi.fn()} onCreated={vi.fn()} />
        </IntlProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function reasoningSelect(labelId: string): HTMLSelectElement {
  return screen.getByRole('combobox', { name: text(labelId), hidden: true }) as HTMLSelectElement;
}

beforeEach(() => {
  vi.mocked(auth.me).mockResolvedValue({
    id: 'user-1',
    isAdmin: false,
    email: 'a@example.com',
    chatAddresses: [],
    planEntitlements: { limits: { childAgentLimitCeiling: 0 } },
  } as unknown as MeResponse);
});

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.clearAllMocks();
});

describe('CreateAgentFlow reasoning defaults and model output warning', () => {
  it('shows the selected style default reasoning when neither the agent nor saved settings set a level', async () => {
    vi.mocked(ai.settings).mockResolvedValue(savedSettings());
    renderFlow();

    const scout = reasoningSelect('agents.edit.models.reasoning.scoutLabel');
    const judge = reasoningSelect('agents.edit.models.reasoning.judgeLabel');
    await waitFor(() => expect(ai.settings).toHaveBeenCalled());
    expect(scout.value).toBe('');
    expect(scout.options[0]!.textContent).toBe('Style default (Low)');
    expect(judge.value).toBe('');
    expect(judge.options[0]!.textContent).toBe('Style default (Medium)');
  });

  it('pre-selects the level saved in AI settings as an explicit choice', async () => {
    vi.mocked(ai.settings).mockResolvedValue(savedSettings({ judgeReasoning: 'high' }));
    renderFlow();

    const judge = reasoningSelect('agents.edit.models.reasoning.judgeLabel');
    await waitFor(() => expect(judge.value).toBe('high'));
    expect(reasoningSelect('agents.edit.models.reasoning.scoutLabel').value).toBe('');
  });

  it('warns when the premium model cannot fit the chosen judge reasoning level', async () => {
    vi.mocked(ai.settings).mockResolvedValue(savedSettings({ heavyModel: 'anthropic/claude-opus-4', judgeReasoning: 'high' }));
    renderFlow();

    const warning = await screen.findByTestId('model-output-limit-warning-judge');
    expect(warning.textContent).toContain('at most 32,000 tokens');
    expect(warning.textContent).toContain(`The ${text('agents.style.balanced.label')} style at ${text('aiModels.reasoning.high')} reasoning may need 36,864`);
    expect(screen.queryByTestId('model-output-limit-warning-scout')).toBeNull();
  });

  it('does not warn when the style default judge level fits the premium model', async () => {
    vi.mocked(ai.settings).mockResolvedValue(savedSettings({ heavyModel: 'anthropic/claude-opus-4', scoutReasoning: 'none' }));
    renderFlow();

    // The saved scout level shows once the saved settings (and their models) are applied.
    await waitFor(() => expect(reasoningSelect('agents.edit.models.reasoning.scoutLabel').value).toBe('none'));
    // balanced judge medium: 12,288 thinking + 16,384 reserve fits 32,000
    expect(reasoningSelect('agents.edit.models.reasoning.judgeLabel').value).toBe('');
    expect(screen.queryByTestId('model-output-limit-warning-judge')).toBeNull();
  });

  it('shows no warning for the default models', async () => {
    vi.mocked(ai.settings).mockResolvedValue(savedSettings({ judgeReasoning: 'high' }));
    renderFlow();

    // The saved level appears once the saved settings (and their models) are applied.
    await waitFor(() => expect(reasoningSelect('agents.edit.models.reasoning.judgeLabel').value).toBe('high'));
    expect(screen.queryByTestId('model-output-limit-warning-judge')).toBeNull();
    expect(screen.queryByTestId('model-output-limit-warning-scout')).toBeNull();
  });
});
