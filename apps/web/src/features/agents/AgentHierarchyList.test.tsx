import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import type { Agent } from '../../lib/api-client.js';
import { AgentHierarchyList } from './AgentHierarchyList.js';

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

const PARENT = makeAgent({ id: 'parent-1', name: 'Parent', status: 'active', childAgentLimit: 5 });

function childOf(status: Agent['status']): Agent {
  return makeAgent({ id: 'child-1', name: 'Child', status, parentAgentId: 'parent-1', depth: 1, creatorId: 'parent-1', creatorType: 'agent' });
}

const PAUSE_ICON = 'title="Pause"';
const STOP_ICON = 'title="Stop"';

describe('AgentHierarchyList child actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows Pause and Stop icons on a child card whose status allows them', () => {
    const html = renderTree([PARENT, childOf('active')]);

    // One Pause and one Stop for the parent card, and one each for the child card.
    expect(html.split(PAUSE_ICON)).toHaveLength(3);
    expect(html.split(STOP_ICON)).toHaveLength(3);
  });

  it('offers only Stop for a paused child', () => {
    const html = renderTree([PARENT, childOf('paused')]);

    expect(html.split(PAUSE_ICON)).toHaveLength(2);
    expect(html.split(STOP_ICON)).toHaveLength(3);
  });

  it('hides Pause and Stop for a child whose status allows neither', () => {
    const html = renderTree([PARENT, childOf('stopped')]);

    expect(html.split(PAUSE_ICON)).toHaveLength(2);
    expect(html.split(STOP_ICON)).toHaveLength(2);
  });
});

describe('AgentHierarchyList nesting', () => {
  const NESTED_PARENT = makeAgent({ id: 'parent-1', name: 'Parent', status: 'active', childAgentLimit: 0 });
  const NESTED_CHILD = makeAgent({
    id: 'child-1', name: 'Child', status: 'stopped', parentAgentId: 'parent-1', depth: 1, creatorId: 'parent-1', creatorType: 'agent',
  });

  it('shows the direct child count on a parent row', () => {
    const html = renderTree([NESTED_PARENT, NESTED_CHILD]);

    expect(html).toContain('1 child<');
  });

  it('omits the creator label on a nested child row', () => {
    const html = renderTree([NESTED_PARENT, NESTED_CHILD]);

    expect(html).not.toContain('Created by Parent');
  });

  it('keeps the creator label on a nested child row while searching', () => {
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <IntlProvider locale="en" messages={messages}>
          <MemoryRouter>
            <AgentHierarchyList agents={[NESTED_PARENT, NESTED_CHILD]} searchQuery="child" />
          </MemoryRouter>
        </IntlProvider>
      </QueryClientProvider>,
    );

    expect(html).toContain('Created by Parent');
  });
});
