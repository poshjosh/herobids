// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import { ApiError, type Agent } from '../../lib/api-client.js';

const updateAgent = vi.fn();

vi.mock('../../lib/api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api-client.js')>();
  return {
    ...actual,
    agents: {
      ...actual.agents,
      update: (_id: string, body: unknown) => updateAgent(body),
      riskDefaults: vi.fn().mockResolvedValue({}),
      capabilityReadiness: vi.fn().mockResolvedValue(null),
      tradingConnections: vi.fn().mockResolvedValue({ connections: [] }),
      getConnections: vi.fn().mockResolvedValue({ connections: [] }),
      listDocuments: vi.fn().mockResolvedValue({ documents: [] }),
    },
    skills: {
      ...actual.skills,
      list: vi.fn().mockResolvedValue({
        skills: [{
          id: 'traderton/skills/crypto-trading',
          name: 'Crypto trading',
          description: 'Trade crypto',
          isSelectable: true,
          capabilityFamilies: ['trading'],
        }],
      }),
    },
    auth: { ...actual.auth, me: vi.fn().mockResolvedValue({ id: 'user-1', isAdmin: false, email: 'a@example.com', chatAddresses: [] }) },
    ai: {
      ...actual.ai,
      settings: vi.fn().mockResolvedValue({ aiModelConfig: null }),
      availableModels: vi.fn().mockResolvedValue({ providers: [] }),
    },
    capabilities: { ...actual.capabilities, tradingConnections: vi.fn().mockResolvedValue({ connections: [] }) },
    connections: { ...actual.connections, list: vi.fn().mockResolvedValue({ connections: [] }) },
    providerCatalog: { ...actual.providerCatalog, get: vi.fn().mockResolvedValue({ providers: [] }) },
  };
});

const TRADING_SKILL_ID = 'traderton/skills/crypto-trading';

vi.mock('./SkillPicker.js', () => ({
  SkillPicker: ({ selectedSkillIds, onChange, initialSkills }: { selectedSkillIds: string[]; onChange: (ids: string[]) => void; initialSkills?: unknown[] }) => (
    // Enabled only once the skills query has resolved, so the added skill is selectable.
    <button
      type="button"
      data-testid="add-trading-skill"
      disabled={(initialSkills ?? []).length === 0}
      onClick={() => onChange([...selectedSkillIds, TRADING_SKILL_ID])}
    >
      add trading skill
    </button>
  ),
}));
vi.mock('../notifications/NotificationsBlock.js', () => ({ NotificationsBlock: () => null }));

import { EditAgentModal } from './EditAgentModal.js';

function text(id: string): string {
  const value = messages[id];
  if (value === undefined) throw new Error(`Missing test message: ${id}`);
  return value;
}

const DEFAULT_HINT = text('agents.controls.tickInterval.defaultHint');
const MAX_HOLD_API_MESSAGE =
  'maxHoldDurationMs (600000ms) must be >= tickIntervalMs (86400000ms). Set maxHoldDurationMs to at least the tick interval, or reduce tickIntervalMs.';

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
    provider: null,
    lightModel: null,
    heavyModel: null,
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

function tickInput(): HTMLInputElement {
  return document.querySelector('[data-field="tickIntervalMins"] input[type="number"]') as HTMLInputElement;
}

function maxHoldInput(): HTMLInputElement {
  return document.getElementById('rp-maxHoldDurationMs') as HTMLInputElement;
}

async function addTradingSkill(): Promise<void> {
  const button = screen.getByTestId('add-trading-skill') as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
}

async function save(): Promise<Record<string, unknown>> {
  fireEvent.submit(document.getElementById('edit-agent-form')!);
  await waitFor(() => expect(updateAgent).toHaveBeenCalledTimes(1));
  return updateAgent.mock.calls[0]![0] as Record<string, unknown>;
}

beforeEach(() => {
  updateAgent.mockResolvedValue({ id: 'agent-123' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('EditAgentModal tick interval', () => {
  it('hydrates a null stored tick as an empty field with the generic hint and omits it when untouched', async () => {
    renderModal(makeAgent({ tickIntervalMs: null, tickIntervalSource: 'unset', effectiveTickIntervalMs: null }));
    expect(tickInput().value).toBe('');
    const hint = screen.getByText(DEFAULT_HINT);
    expect(tickInput().getAttribute('aria-describedby')).toBe(hint.id);
    const body = await save();
    expect(body).not.toHaveProperty('tickIntervalMs');
  });

  it('omits the tick when a trading skill is added to a legacy 24h agent so the API can replace it', async () => {
    renderModal(makeAgent({ skillIds: [], tickIntervalMs: 86_400_000, tickIntervalSource: 'user', effectiveTickIntervalMs: 86_400_000 }));
    expect(tickInput().value).toBe('1440');
    await addTradingSkill();
    const body = await save();
    expect(body.skillIds).toEqual([TRADING_SKILL_ID]);
    expect(body).not.toHaveProperty('tickIntervalMs');
  });

  it('sends the typed tick when a trading skill is added and the user also edits the tick', async () => {
    renderModal(makeAgent({ skillIds: [], tickIntervalMs: 86_400_000, tickIntervalSource: 'user', effectiveTickIntervalMs: 86_400_000 }));
    await addTradingSkill();
    fireEvent.change(tickInput(), { target: { value: '30' } });
    const body = await save();
    expect(body.tickIntervalMs).toBe(1_800_000);
  });

  it('shows the server effective default as helper text without filling the field or persisting it', async () => {
    renderModal(makeAgent({ tickIntervalMs: null, tickIntervalSource: 'non_trading_default', effectiveTickIntervalMs: 86_400_000 }));
    expect(tickInput().value).toBe('');
    const notice = screen.getByText(/Using the default for this agent's skills: every 24h/);
    expect(tickInput().getAttribute('aria-describedby')).toBe(notice.id);
    const body = await save();
    expect(body).not.toHaveProperty('tickIntervalMs');
  });

  it('drops the effective-default notice once the user types a value, and sends it as explicit', async () => {
    renderModal(makeAgent({ tickIntervalMs: null, tickIntervalSource: 'non_trading_default', effectiveTickIntervalMs: 86_400_000 }));
    fireEvent.change(tickInput(), { target: { value: '60' } });
    expect(screen.queryByText(/Using the default for this agent's skills/)).toBeNull();
    const body = await save();
    expect(body.tickIntervalMs).toBe(3_600_000);
  });

  it('hydrates a stored explicit tick as that value and leaves it to the API (omitted) when untouched', async () => {
    renderModal(makeAgent({ tickIntervalMs: 5_400_000, tickIntervalSource: 'user', effectiveTickIntervalMs: 5_400_000 }));
    expect(tickInput().value).toBe('90');
    expect(screen.queryByText(DEFAULT_HINT)).toBeNull();
    const body = await save();
    expect(body).not.toHaveProperty('tickIntervalMs');
  });

  it('sends null (use default) when the user clears a stored explicit value', async () => {
    renderModal(makeAgent({ tickIntervalMs: 86_400_000, tickIntervalSource: 'user', effectiveTickIntervalMs: 86_400_000 }));
    expect(tickInput().value).toBe('1440');
    fireEvent.change(tickInput(), { target: { value: '' } });
    const body = await save();
    expect(body.tickIntervalMs).toBeNull();
  });

  it('does not touch the tick or max-hold fields when the style changes', async () => {
    renderModal(makeAgent({ tickIntervalMs: 86_400_000, tickIntervalSource: 'user', effectiveTickIntervalMs: 86_400_000 }));
    fireEvent.change(screen.getByDisplayValue(text('agents.style.balanced.label')), { target: { value: 'careful' } });
    expect(tickInput().value).toBe('1440');
    expect(maxHoldInput().value).toBe('');
    const body = await save();
    expect(body).not.toHaveProperty('tickIntervalMs');
    expect(body.runtimePolicyOverrides ?? null).toBeNull();
  });

  it('hydrates only a stored explicit max-hold override', () => {
    renderModal(makeAgent({ runtimePolicyOverrides: { maxHoldDurationMs: 7_200_000 } as Agent['runtimePolicyOverrides'] }));
    expect(maxHoldInput().value).toBe('120');
  });

  it('shows the API max-hold 400 against the field instead of a banner', async () => {
    updateAgent.mockRejectedValue(new ApiError(400, 'validation_error', 'Invalid request', undefined, [
      { path: ['runtimePolicyOverrides', 'maxHoldDurationMs'], message: MAX_HOLD_API_MESSAGE },
    ]));
    renderModal(makeAgent({ tickIntervalMs: 86_400_000, tickIntervalSource: 'user', effectiveTickIntervalMs: 86_400_000 }));
    fireEvent.change(maxHoldInput(), { target: { value: '10' } });
    fireEvent.submit(document.getElementById('edit-agent-form')!);

    const error = await screen.findByText(MAX_HOLD_API_MESSAGE);
    expect(error.id).toBe('rp-maxHoldDurationMs-error');
    expect(maxHoldInput().getAttribute('aria-describedby')).toBe(error.id);
    expect(screen.getAllByText(MAX_HOLD_API_MESSAGE)).toHaveLength(1);
  });

  it('opens the Advanced section on the AI tab when the API rejects max hold', async () => {
    updateAgent.mockRejectedValue(new ApiError(400, 'validation_error', 'Invalid request', undefined, [
      { path: ['runtimePolicyOverrides', 'maxHoldDurationMs'], message: MAX_HOLD_API_MESSAGE },
    ]));
    renderModal(makeAgent({ tickIntervalMs: 86_400_000, tickIntervalSource: 'user', effectiveTickIntervalMs: 86_400_000 }));
    fireEvent.change(maxHoldInput(), { target: { value: '10' } });
    fireEvent.submit(document.getElementById('edit-agent-form')!);
    await screen.findByText(MAX_HOLD_API_MESSAGE);
    expect((document.querySelector('details') as HTMLDetailsElement).open).toBe(true);
    expect(screen.getByRole('tab', { name: /AI/, hidden: true }).getAttribute('aria-selected')).toBe('true');
  });

  it('shows no cadence estimate for a server-resolved default the user never set', () => {
    renderModal(makeAgent({ tickIntervalMs: null, tickIntervalSource: 'non_trading_default', effectiveTickIntervalMs: 86_400_000 }));
    expect(screen.getByText(/Using the default for this agent's skills: every 24h/)).toBeTruthy();
    expect(screen.queryByText(/Expected cadence|Base cadence/)).toBeNull();
    expect(screen.queryByText(/Estimated daily LLM spend/)).toBeNull();
  });
});
