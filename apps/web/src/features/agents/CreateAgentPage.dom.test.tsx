// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IntlProvider } from 'react-intl';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import { CreateAgentPage } from './CreateAgentPage.js';

vi.mock('../../lib/api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api-client.js')>();
  return { ...actual, skills: { ...actual.skills, list: vi.fn().mockResolvedValue({ skills: [] }) } };
});

// The real form is large and API-bound. The stub exposes the callbacks the page wires up.
vi.mock('./CreateAgentFlow.js', () => ({
  CreateAgentFlow: (props: { onCreated: (id: string) => void | Promise<void>; onClose: () => void }) => (
    <>
      <button type="button" onClick={() => { onCreatedResult = props.onCreated('agent-new'); }}>finish create</button>
      <button type="button" onClick={props.onClose}>close form</button>
    </>
  ),
}));

/** What the page's onCreated returned on the last stubbed call. */
let onCreatedResult: void | Promise<void> | undefined;

/** Stands in for the agents page and shows which chat it was asked to open. */
function AgentsPageProbe() {
  return <div data-testid="agents-page">{useLocation().search}</div>;
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages}>
        <MemoryRouter initialEntries={['/agents/new']}>
          <Routes>
            <Route path="/agents/new" element={<CreateAgentPage />} />
            <Route path="/agents" element={<AgentsPageProbe />} />
          </Routes>
        </MemoryRouter>
      </IntlProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

afterEach(() => cleanup());

describe('CreateAgentPage', () => {
  it('opens the new agent chat after creating it, with only the agents list refetched', async () => {
    const queryClient = renderPage();
    const refetch = vi.spyOn(queryClient, 'refetchQueries');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'finish create' }));
    });
    expect(refetch).toHaveBeenCalledWith({ queryKey: ['agents'], exact: true });
    expect((await screen.findByTestId('agents-page')).textContent).toBe('?agent=agent-new');
  });

  it('returns to the agents page when the form is closed', () => {
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'close form' }));
    expect(screen.getByTestId('agents-page').textContent).toBe('');
  });

  it('gives the create flow a promise that settles only after navigation, so it stays pending', async () => {
    const queryClient = renderPage();
    let finishRefetch: () => void = () => undefined;
    vi.spyOn(queryClient, 'refetchQueries').mockReturnValue(new Promise<void>((resolve) => { finishRefetch = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'finish create' }));
    expect(onCreatedResult).toBeInstanceOf(Promise);
    let settled = false;
    void (onCreatedResult as Promise<void>).then(() => { settled = true; });
    await act(async () => { await Promise.resolve(); });
    expect(settled).toBe(false);
    expect(screen.queryByTestId('agents-page')).toBeNull();
    await act(async () => { finishRefetch(); });
    expect(settled).toBe(true);
    expect(screen.getByTestId('agents-page').textContent).toBe('?agent=agent-new');
  });
});
