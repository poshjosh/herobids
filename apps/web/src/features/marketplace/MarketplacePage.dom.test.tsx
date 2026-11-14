// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IntlProvider } from 'react-intl';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import type { BlueprintSummary } from '../../lib/api-client.js';
import { MarketplacePage } from './MarketplacePage.js';

const BLUEPRINT = { id: 'bp-1', name: 'Job hunter' } as unknown as BlueprintSummary;

// The real browse list and instantiate modal call the API. These stubs expose the callbacks the page wires up.
vi.mock('../blueprints/BlueprintBrowse.js', () => ({
  BlueprintBrowse: (props: { defaultKind?: string; onUseBlueprint?: (blueprint: BlueprintSummary) => void }) => (
    <button type="button" data-kind={props.defaultKind} onClick={() => props.onUseBlueprint?.(BLUEPRINT)}>use blueprint</button>
  ),
}));
vi.mock('../blueprints/BlueprintInstantiateFlow.js', () => ({
  BlueprintInstantiateFlow: (props: { onCreated?: (actorId: string) => void | Promise<void> }) => (
    <button type="button" onClick={() => { onCreatedResult = props.onCreated?.('agent-new'); }}>finish instantiate</button>
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
        <MemoryRouter initialEntries={['/marketplace']}>
          <Routes>
            <Route path="/marketplace" element={<MarketplacePage />} />
            <Route path="/agents" element={<AgentsPageProbe />} />
          </Routes>
        </MemoryRouter>
      </IntlProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

afterEach(() => cleanup());

describe('MarketplacePage', () => {
  it('shows the marketplace title and browses agent blueprints', () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: messages['marketplace.title'] })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'use blueprint' }).getAttribute('data-kind')).toBe('agent');
  });

  it('opens the new agent chat after a blueprint is used, with only the agents list refetched', async () => {
    const queryClient = renderPage();
    const refetch = vi.spyOn(queryClient, 'refetchQueries');
    fireEvent.click(screen.getByRole('button', { name: 'use blueprint' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'finish instantiate' }));
    });
    expect(refetch).toHaveBeenCalledWith({ queryKey: ['agents'], exact: true });
    expect((await screen.findByTestId('agents-page')).textContent).toBe('?agent=agent-new');
  });

  it('gives the instantiate modal a promise that settles only after navigation, so it stays pending', async () => {
    const queryClient = renderPage();
    let finishRefetch: () => void = () => undefined;
    vi.spyOn(queryClient, 'refetchQueries').mockReturnValue(new Promise<void>((resolve) => { finishRefetch = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'use blueprint' }));
    fireEvent.click(screen.getByRole('button', { name: 'finish instantiate' }));
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
