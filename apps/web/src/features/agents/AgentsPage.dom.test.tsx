// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IntlProvider } from 'react-intl';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import { agents as agentsApi, type Agent } from '../../lib/api-client.js';
import { AgentsPage } from './AgentsPage.js';

vi.mock('../../lib/api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api-client.js')>();
  return {
    ...actual,
    agents: { ...actual.agents, list: vi.fn() },
  };
});

// The real conversation fetches sessions and messages. This probe records what the page passes in.
vi.mock('./AgentConversation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./AgentConversation.js')>();
  return {
    ...actual,
    AgentConversation: (props: {
      agentId: string;
      initialDraft?: string;
      onDraftChange?: (value: string) => void;
    }) => (
      <div data-testid="chat" data-agent={props.agentId}>
        <textarea
          aria-label="chat draft"
          value={props.initialDraft ?? ''}
          onChange={(event) => props.onDraftChange?.(event.target.value)}
        />
      </div>
    ),
  };
});

vi.mock('./AgentHierarchyList.js', () => ({ AgentHierarchyList: () => <div>hierarchy</div> }));
vi.mock('../notifications/NotificationsBlock.js', () => ({ NotificationsBlock: () => null }));
vi.mock('../blueprints/BlueprintBrowse.js', () => ({ BlueprintBrowse: () => null }));
vi.mock('../blueprints/BlueprintInstantiateFlow.js', () => ({ BlueprintInstantiateFlow: () => null }));
vi.mock('../../lib/useEventStream.js', () => ({ useEventStream: () => undefined }));

function text(id: string): string {
  const value = messages[id];
  if (value === undefined) {
    throw new Error(`missing message ${id}`);
  }
  return value;
}

function agent(id: string, name: string, status: string): Agent {
  return { id, name, status } as unknown as Agent;
}

const AGENTS = [
  agent('agent-stopped', 'Stopped bot', 'stopped'),
  agent('agent-active', 'Active bot', 'active'),
  agent('agent-second', 'Second bot', 'active'),
];

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages}>
        <MemoryRouter initialEntries={['/agents']}>
          <Routes>
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/agents/:id/details" element={<div>details page</div>} />
            <Route path="/agents/new" element={<div>create page</div>} />
          </Routes>
        </MemoryRouter>
      </IntlProvider>
    </QueryClientProvider>,
  );
}

const CHAT_KEY = 'agents-page-chat-agent';
const selectAgent = () => screen.getByLabelText(text('agents.chat.selectAgent')) as HTMLSelectElement;
const chatAgentId = () => screen.getByTestId('chat').getAttribute('data-agent');

describe('AgentsPage chat box', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(agentsApi.list).mockResolvedValue(AGENTS);
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.clearAllMocks();
    delete (window as { matchMedia?: unknown }).matchMedia;
  });

  it('lists every agent and defaults to the first agent that can take messages', async () => {
    renderPage();
    await screen.findByTestId('chat');

    expect(selectAgent().options).toHaveLength(3);
    expect(chatAgentId()).toBe('agent-active');
  });

  it('restores the remembered agent on a later visit', async () => {
    localStorage.setItem(CHAT_KEY, 'agent-second');
    renderPage();
    await screen.findByTestId('chat');

    expect(chatAgentId()).toBe('agent-second');
  });

  it('falls back when the remembered agent no longer exists', async () => {
    localStorage.setItem(CHAT_KEY, 'deleted-agent');
    renderPage();
    await screen.findByTestId('chat');

    expect(chatAgentId()).toBe('agent-active');
  });

  it('switches the chat and remembers the new selection', async () => {
    renderPage();
    await screen.findByTestId('chat');

    fireEvent.change(selectAgent(), { target: { value: 'agent-second' } });

    expect(chatAgentId()).toBe('agent-second');
    expect(localStorage.getItem(CHAT_KEY)).toBe('agent-second');
  });

  it('keeps an unsent draft for each agent while switching', async () => {
    renderPage();
    await screen.findByTestId('chat');

    fireEvent.change(screen.getByLabelText('chat draft'), { target: { value: 'buy ETH' } });
    fireEvent.change(selectAgent(), { target: { value: 'agent-second' } });
    expect((screen.getByLabelText('chat draft') as HTMLTextAreaElement).value).toBe('');

    fireEvent.change(screen.getByLabelText('chat draft'), { target: { value: 'sell BTC' } });
    fireEvent.change(selectAgent(), { target: { value: 'agent-active' } });
    expect((screen.getByLabelText('chat draft') as HTMLTextAreaElement).value).toBe('buy ETH');

    fireEvent.change(selectAgent(), { target: { value: 'agent-second' } });
    expect((screen.getByLabelText('chat draft') as HTMLTextAreaElement).value).toBe('sell BTC');
  });

  it('has no Details button next to the chat picker', async () => {
    renderPage();
    await screen.findByTestId('chat');

    expect(screen.queryByRole('button', { name: text('agentDetail.chat.details') })).toBeNull();
  });

  it('hides the search box on desktop until there are more than five agents', async () => {
    renderPage();
    await screen.findByTestId('chat');

    expect(screen.queryByRole('searchbox', { name: text('agents.tree.search') })).toBeNull();
  });

  it('shows the search box on desktop once there are more than five agents', async () => {
    vi.mocked(agentsApi.list).mockResolvedValue([
      ...AGENTS,
      agent('agent-4', 'Bot four', 'active'),
      agent('agent-5', 'Bot five', 'active'),
      agent('agent-6', 'Bot six', 'stopped'),
    ]);
    renderPage();
    await screen.findByTestId('chat');

    expect(screen.getByRole('searchbox', { name: text('agents.tree.search') })).toBeTruthy();
  });

  it('shows the search box on mobile once there are more than two agents', async () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === '(max-width: 640px)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    renderPage();
    await screen.findByTestId('chat');

    expect(screen.getByRole('searchbox', { name: text('agents.tree.search') })).toBeTruthy();
  });

  it('keeps the tabs and the rest of the page below the chat', async () => {
    renderPage();
    await screen.findByTestId('chat');

    expect(screen.getByRole('button', { name: 'My Agents' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Marketplace' })).toBeTruthy();
    expect(screen.getByText('hierarchy')).toBeTruthy();
    expect(screen.getByRole('button', { name: text('agents.create.title') })).toBeTruthy();
  });
});
