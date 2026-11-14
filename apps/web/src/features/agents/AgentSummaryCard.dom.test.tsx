// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IntlProvider } from 'react-intl';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import type { Agent } from '../../lib/api-client.js';
import { AgentSummaryCard } from './AgentSummaryCard.js';

vi.mock('../../lib/api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api-client.js')>();
  return {
    ...actual,
    agents: { ...actual.agents, getConnections: vi.fn().mockResolvedValue({ agentId: 'agent-1', connections: [] }) },
    skills: { ...actual.skills, list: vi.fn().mockResolvedValue({ skills: [] }) },
  };
});

const AGENT = {
  id: 'agent-1',
  name: 'Research helper',
  status: 'active',
  prompt: '',
  skillIds: [],
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
} as unknown as Agent;

/** Shows where the card navigated to. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

function renderCard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages}>
        <MemoryRouter initialEntries={['/agents']}>
          <Routes>
            <Route path="*" element={<><AgentSummaryCard agent={AGENT} /><LocationProbe /></>} />
          </Routes>
        </MemoryRouter>
      </IntlProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => cleanup());

describe('AgentSummaryCard', () => {
  it('opens the agent chat when the card is clicked', () => {
    renderCard();
    fireEvent.click(screen.getByText('Research helper'));
    expect(screen.getByTestId('location').textContent).toBe('/agents?agent=agent-1');
  });

  it('opens the agent settings from the Settings button without opening the chat', () => {
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: messages['agents.quickActions.settings'] }));
    expect(screen.getByTestId('location').textContent).toBe('/agents/agent-1');
  });
});
