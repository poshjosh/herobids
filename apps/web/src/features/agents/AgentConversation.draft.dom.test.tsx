// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IntlProvider } from 'react-intl';
import { messages } from '../../app/i18n/locales/en.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agents as agentsApi } from '../../lib/api-client.js';
import { AgentConversation } from './AgentConversation.js';

vi.mock('../../lib/api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api-client.js')>();
  return {
    ...actual,
    agents: {
      ...actual.agents,
      sessions: vi.fn(),
      conversation: vi.fn(),
      conversationTurn: vi.fn(),
      sendMessage: vi.fn(),
    },
  };
});

const COMPOSER_LABEL = 'Chat with Bot';

function mockEmptyThread() {
  vi.mocked(agentsApi.sessions).mockResolvedValue([]);
  vi.mocked(agentsApi.conversation).mockResolvedValue({ messages: [], nextCursor: null, maxMessageChars: 4000 });
  vi.mocked(agentsApi.conversationTurn).mockResolvedValue(null as never);
}

function renderConversation(props: { initialDraft?: string; onDraftChange?: (value: string) => void }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages}>
        <AgentConversation agentId="agent-1" agentName="Bot" status="active" {...props} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('AgentConversation draft', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('starts with the draft it was given', async () => {
    mockEmptyThread();

    renderConversation({ initialDraft: 'buy ETH' });

    await waitFor(() => {
      expect((screen.getByLabelText(COMPOSER_LABEL) as HTMLTextAreaElement).value).toBe('buy ETH');
    });
  });

  it('reports every change to the draft', async () => {
    mockEmptyThread();
    const onDraftChange = vi.fn();

    renderConversation({ onDraftChange });
    fireEvent.change(await screen.findByLabelText(COMPOSER_LABEL), { target: { value: 'sell BTC' } });

    expect(onDraftChange).toHaveBeenLastCalledWith('sell BTC');
  });
});
