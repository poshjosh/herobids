// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IntlProvider } from 'react-intl';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import type { Agent } from '../../lib/api-client.js';

// The page fetches the agent and subscribes to the event stream. Mock those
// boundaries, and stub the heavy details panel, so the test focuses on the
// page shell: the Back to Agents button and the absence of the chat box.
const getAgent = vi.fn();

vi.mock('../../lib/api-client.js', () => ({
  agents: {
    get: (...args: unknown[]) => getAgent(...args),
  },
}));

vi.mock('../../lib/useEventStream.js', () => ({
  useEventStream: () => undefined,
}));

vi.mock('./AgentDetailPage.js', () => ({
  AgentDetails: () => <div data-testid="agent-details">details</div>,
}));

// AgentConversation is the chat box. The stub makes it detectable if the page
// ever renders it again.
vi.mock('./AgentConversation.js', () => ({
  AgentConversation: () => <div data-testid="agent-conversation">chat box</div>,
  CONVERSATION_POLL_MS: 3000,
  formatMessageTime: () => '',
}));

import { AgentChatPage } from './AgentChatPage.js';

function makeAgent(): Agent {
  return {
    id: 'agent-1',
    name: 'Test agent',
  } as unknown as Agent;
}

function renderPage() {
  getAgent.mockResolvedValue(makeAgent());
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages}>
        <MemoryRouter initialEntries={['/agents/agent-1']}>
          <Routes>
            <Route path="/agents/:id" element={<AgentChatPage />} />
            <Route path="/agents" element={<div>Agents list</div>} />
          </Routes>
        </MemoryRouter>
      </IntlProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => cleanup());

describe('AgentChatPage', () => {
  it('shows a Back to Agents button in the header that navigates to the agents list', async () => {
    renderPage();

    const button = await screen.findByRole('button', { name: 'Back to Agents' });
    fireEvent.click(button);

    expect(await screen.findByText('Agents list')).toBeTruthy();
  });

  it('does not render the chat box', async () => {
    renderPage();

    // Details render once the agent loads.
    await screen.findByTestId('agent-details');

    expect(screen.queryByTestId('agent-conversation')).toBeNull();
    // The chat composer's Send affordance must be gone too.
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });
});
