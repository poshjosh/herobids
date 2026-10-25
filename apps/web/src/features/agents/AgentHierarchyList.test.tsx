import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import { agents as agentsApi, type Agent } from '../../lib/api-client.js';
import { AgentHierarchyList } from './AgentHierarchyList.js';
import { ChildAgentLifecycleControls, pauseChildAgent, stopChildAgent } from './ChildAgentLifecycleActions.js';

vi.mock('../../lib/api-client.js', () => ({
  ApiError: class ApiError extends Error {},
  agents: {
    pause: vi.fn(),
    stop: vi.fn(),
    sendMessage: vi.fn(),
    getConnections: vi.fn(() => new Promise(() => {})),
  },
  skills: {
    list: vi.fn(() => new Promise(() => {})),
  },
}));

function makeAgent(overrides: Partial<Agent> & Pick<Agent, 'id' | 'name'>): Agent {
  return {
    userId: 'user-1',
    prompt: '',
    skillIds: [],
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
    chatAddresses: [],
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
    createdAt: '2026-10-25T00:00:00.000Z',
    updatedAt: '2026-10-25T00:00:00.000Z',
    creatorType: 'user',
    creatorId: 'user-1',
    parentAgentId: null,
    depth: 0,
    childAgentLimit: 0,
    ...overrides,
  };
}

function renderTree(agents: Agent[]): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <IntlProvider locale="en" messages={messages}>
        <MemoryRouter>
          <AgentHierarchyList agents={agents} searchQuery="" />
        </MemoryRouter>
      </IntlProvider>
    </QueryClientProvider>,
  );
}

function renderControls(props: Partial<Parameters<typeof ChildAgentLifecycleControls>[0]> = {}): string {
  return renderToStaticMarkup(
    <IntlProvider locale="en" messages={messages}>
      <ChildAgentLifecycleControls
        showPause
        showStop
        pending={false}
        errorMessage={null}
        onPause={() => undefined}
        onStop={() => undefined}
        {...props}
      />
    </IntlProvider>,
  );
}

const PARENT = makeAgent({ id: 'parent-1', name: 'Parent', status: 'active', childAgentLimit: 5 });

function childOf(status: Agent['status']): Agent {
  return makeAgent({ id: 'child-1', name: 'Child', status, parentAgentId: 'parent-1', depth: 1, creatorId: 'parent-1', creatorType: 'agent' });
}

const PAUSE_BUTTON = '>Pause</button>';
const STOP_BUTTON = '>Stop</button>';

describe('AgentHierarchyList child row actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows Pause and Stop on a child row whose status allows them', () => {
    const html = renderTree([PARENT, childOf('active')]);

    expect(html).toContain(PAUSE_BUTTON);
    expect(html).toContain(STOP_BUTTON);
    // Only the child row renders the text buttons; the parent card keeps its icon-only actions.
    expect(html.split(PAUSE_BUTTON)).toHaveLength(2);
  });

  it('offers only Stop for a paused child', () => {
    const html = renderTree([PARENT, childOf('paused')]);

    expect(html).not.toContain(PAUSE_BUTTON);
    expect(html).toContain(STOP_BUTTON);
  });

  it('hides Pause and Stop for a child whose status allows neither', () => {
    const html = renderTree([PARENT, childOf('stopped')]);

    expect(html).not.toContain(PAUSE_BUTTON);
    expect(html).not.toContain(STOP_BUTTON);
  });

  it('calls the pause and stop API functions with the child id', async () => {
    vi.mocked(agentsApi.pause).mockResolvedValueOnce({ status: 'paused' });
    vi.mocked(agentsApi.stop).mockResolvedValueOnce({ status: 'stopped' });

    await pauseChildAgent('child-1');
    await stopChildAgent('child-1');

    expect(agentsApi.pause).toHaveBeenCalledWith('child-1', 'User paused from dashboard');
    expect(agentsApi.stop).toHaveBeenCalledWith('child-1');
  });

  it('propagates an API failure so the row can show it', async () => {
    vi.mocked(agentsApi.pause).mockRejectedValueOnce(new Error('Agent is busy'));

    await expect(pauseChildAgent('child-1')).rejects.toThrow('Agent is busy');
  });

  it('shows an inline error next to the child actions', () => {
    const html = renderControls({ errorMessage: 'Something went wrong' });

    expect(html).toContain('Something went wrong');
    expect(html).toContain(PAUSE_BUTTON);
    expect(html).toContain(STOP_BUTTON);
  });

  it('renders no error when the action has not failed', () => {
    const html = renderControls({ errorMessage: null });

    expect(html).not.toContain('Something went wrong');
  });
});
