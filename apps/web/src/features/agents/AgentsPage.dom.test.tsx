// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IntlProvider } from 'react-intl';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
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
      connectionRequestId?: string | null;
      initialDraft?: string;
      onDraftChange?: (value: string) => void;
      composerActions?: React.ReactNode;
    }) => (
      <div data-testid="chat" data-agent={props.agentId} data-connection={props.connectionRequestId ?? ''}>
        {props.composerActions}
        <textarea
          aria-label="chat draft"
          value={props.initialDraft ?? ''}
          onChange={(event) => props.onDraftChange?.(event.target.value)}
        />
      </div>
    ),
  };
});

vi.mock('./AgentQuickActions.js', () => ({ AgentQuickActions: () => <div data-testid="quick-actions" /> }));
vi.mock('./AgentHierarchyList.js', () => ({ AgentHierarchyList: () => <div>hierarchy</div> }));
vi.mock('../notifications/NotificationsBlock.js', () => ({ NotificationsBlock: () => null }));
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

/** Shows the current URL, so tests can check the page removed the chat parameters. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

function renderPage(initialEntry = '/agents') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Routes>
            <Route path="/agents" element={<><AgentsPage /><LocationProbe /></>} />
            <Route path="/agents/new" element={<div>create page</div>} />
            <Route path="/onboarding" element={<div>onboarding page</div>} />
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
    localStorage.setItem(CHAT_KEY, 'agent-active');
    vi.mocked(agentsApi.list).mockResolvedValue(AGENTS);
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.clearAllMocks();
    delete (window as { matchMedia?: unknown }).matchMedia;
  });

  it('lists every agent and preselects the first running agent when nothing is remembered', async () => {
    localStorage.removeItem(CHAT_KEY);
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

  it('falls back to the first running agent when the remembered agent no longer exists', async () => {
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

  it('shows the agent quick actions in the chat box on every screen size', async () => {
    renderPage();
    await screen.findByTestId('chat');

    expect(screen.getByTestId('quick-actions')).toBeTruthy();
  });

  it('has no Details button next to the chat picker', async () => {
    renderPage();
    await screen.findByTestId('chat');

    expect(screen.queryByRole('button', { name: /details/i })).toBeNull();
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

  it('shows the agents list and the create button below the chat, with no marketplace tab', async () => {
    renderPage();
    await screen.findByTestId('chat');
    expect(screen.getByRole('heading', { name: text('agents.myAgents') })).toBeTruthy();
    expect(screen.getByText('hierarchy')).toBeTruthy();
    expect(screen.getByRole('button', { name: text('agents.create.title') })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Marketplace' })).toBeNull();
  });

  it('opens the chat of the agent named in the link, remembers it, and cleans the URL', async () => {
    renderPage('/agents?agent=agent-second');
    await screen.findByTestId('chat');
    expect(chatAgentId()).toBe('agent-second');
    expect(localStorage.getItem(CHAT_KEY)).toBe('agent-second');
    expect(screen.getByTestId('location').textContent).toBe('/agents');
  });

  it('passes an approved connection request to the linked agent chat only', async () => {
    renderPage('/agents?agent=agent-second&connected=req-1');
    await screen.findByTestId('chat');
    expect(screen.getByTestId('chat').getAttribute('data-connection')).toBe('req-1');
    fireEvent.change(selectAgent(), { target: { value: 'agent-active' } });
    expect(screen.getByTestId('chat').getAttribute('data-connection')).toBe('');
  });

  it('does not pass the approved connection request again when the user returns to that agent', async () => {
    renderPage('/agents?agent=agent-second&connected=req-1');
    await screen.findByTestId('chat');
    fireEvent.change(selectAgent(), { target: { value: 'agent-active' } });
    fireEvent.change(selectAgent(), { target: { value: 'agent-second' } });

    expect(chatAgentId()).toBe('agent-second');
    expect(screen.getByTestId('chat').getAttribute('data-connection')).toBe('');
  });

  it('sends users with no agents to the guided onboarding', async () => {
    vi.mocked(agentsApi.list).mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('onboarding page')).toBeTruthy();
  });
});
