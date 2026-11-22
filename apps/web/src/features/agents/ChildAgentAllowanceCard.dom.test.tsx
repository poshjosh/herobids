// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import type { Agent, AgentChildAllowance } from '../../lib/api-client.js';

const childAllowance = vi.fn();
const setChildLimit = vi.fn();
const setChildGrantScope = vi.fn();

vi.mock('../../lib/api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api-client.js')>();
  return {
    ...actual,
    agents: {
      ...actual.agents,
      childAllowance: (id: string) => childAllowance(id),
      setChildLimit: (id: string, limit: number) => setChildLimit(id, limit),
      setChildGrantScope: (id: string, scope: unknown) => setChildGrantScope(id, scope),
    },
  };
});

import { ChildAgentAllowanceCard } from './ChildAgentAllowanceCard.js';

function text(id: string): string {
  const value = messages[id];
  if (value === undefined) throw new Error(`Missing test message: ${id}`);
  return value;
}

const AGENT = { id: 'agent-1' } as Agent;
const SKILLS_LABEL = text('agents.allowance.grantSkills');
const CONNECTIONS_LABEL = text('agents.allowance.grantConnections');

function allowance(overrides: Partial<AgentChildAllowance> = {}): AgentChildAllowance {
  return {
    id: 'agent-1',
    childAgentLimit: 2,
    grantAnySkillToChildren: false,
    grantAnyConnectionToChildren: false,
    childCount: 0,
    remainingChildAllowance: 2,
    ...overrides,
  };
}

function renderCard(ceiling = 5) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages}>
        <ChildAgentAllowanceCard agent={AGENT} ceiling={ceiling} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  setChildLimit.mockResolvedValue({ childAgentLimit: 2 });
  setChildGrantScope.mockResolvedValue({ grantAnySkillToChildren: true, grantAnyConnectionToChildren: false });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ChildAgentAllowanceCard grant scope', () => {
  it('saves both flags through the grant-scope route and leaves the limit alone', async () => {
    childAllowance.mockResolvedValue(allowance());
    renderCard();

    fireEvent.click(await screen.findByLabelText(SKILLS_LABEL));
    fireEvent.click(screen.getByLabelText(CONNECTIONS_LABEL));
    fireEvent.click(screen.getByRole('button', { name: text('agents.allowance.save') }));

    await waitFor(() => expect(setChildGrantScope).toHaveBeenCalledTimes(1));
    expect(setChildGrantScope).toHaveBeenCalledWith('agent-1', {
      grantAnySkillToChildren: true,
      grantAnyConnectionToChildren: true,
    });
    expect(setChildLimit).not.toHaveBeenCalled();
  });

  it('saves the limit and the flags together when both changed', async () => {
    childAllowance.mockResolvedValue(allowance({ grantAnyConnectionToChildren: true }));
    renderCard();

    fireEvent.change(await screen.findByLabelText(text('agents.allowance.limitLabel')), { target: { value: '4' } });
    fireEvent.click(screen.getByLabelText(CONNECTIONS_LABEL));
    fireEvent.click(screen.getByRole('button', { name: text('agents.allowance.save') }));

    await waitFor(() => expect(setChildGrantScope).toHaveBeenCalledTimes(1));
    expect(setChildLimit).toHaveBeenCalledWith('agent-1', 4);
    expect(setChildGrantScope).toHaveBeenCalledWith('agent-1', {
      grantAnySkillToChildren: false,
      grantAnyConnectionToChildren: false,
    });
  });

  it('shows the saved flags and keeps Save disabled until something changes', async () => {
    childAllowance.mockResolvedValue(allowance({ grantAnySkillToChildren: true }));
    renderCard();

    expect((await screen.findByLabelText(SKILLS_LABEL) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(CONNECTIONS_LABEL) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('button', { name: text('agents.allowance.save') }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('describes the connections checkbox with the warning and explains future-only effect', async () => {
    childAllowance.mockResolvedValue(allowance());
    renderCard();

    const connections = await screen.findByLabelText(CONNECTIONS_LABEL);
    const describedBy = connections.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toBe(text('agents.allowance.grantConnectionsWarning'));
    expect(screen.getByText(text('agents.allowance.grantScopeNote'))).toBeTruthy();
  });

  it('shows the checkboxes only while the limit is above 0', async () => {
    childAllowance.mockResolvedValue(allowance({ childAgentLimit: 0 }));
    renderCard();

    const limit = await screen.findByLabelText(text('agents.allowance.limitLabel'));
    expect(screen.queryByLabelText(SKILLS_LABEL)).toBeNull();
    expect(screen.queryByLabelText(CONNECTIONS_LABEL)).toBeNull();

    fireEvent.change(limit, { target: { value: '3' } });
    expect(screen.getByLabelText(SKILLS_LABEL)).toBeTruthy();
    expect(screen.getByLabelText(CONNECTIONS_LABEL)).toBeTruthy();

    fireEvent.change(limit, { target: { value: '0' } });
    expect(screen.queryByLabelText(SKILLS_LABEL)).toBeNull();
  });

  it('does not save a flag ticked before the limit was set to 0', async () => {
    childAllowance.mockResolvedValue(allowance({ childAgentLimit: 2 }));
    renderCard();

    const limit = await screen.findByLabelText(text('agents.allowance.limitLabel'));
    fireEvent.click(screen.getByLabelText(SKILLS_LABEL));
    fireEvent.change(limit, { target: { value: '0' } });
    expect(screen.queryByLabelText(SKILLS_LABEL)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: text('agents.allowance.save') }));

    await waitFor(() => expect(setChildLimit).toHaveBeenCalledWith('agent-1', 0));
    expect(setChildGrantScope).not.toHaveBeenCalled();
  });

  it('keeps a saved flag visible and revocable at limit 0, with a note', async () => {
    childAllowance.mockResolvedValue(allowance({ childAgentLimit: 0, grantAnySkillToChildren: true }));
    renderCard();

    const skills = await screen.findByLabelText(SKILLS_LABEL) as HTMLInputElement;
    expect(skills.checked).toBe(true);
    expect(screen.getByText(text('agents.allowance.grantScopeInactive'))).toBeTruthy();

    fireEvent.click(skills);
    fireEvent.click(screen.getByRole('button', { name: text('agents.allowance.save') }));

    await waitFor(() => expect(setChildGrantScope).toHaveBeenCalledWith('agent-1', {
      grantAnySkillToChildren: false,
      grantAnyConnectionToChildren: false,
    }));
    expect(setChildLimit).not.toHaveBeenCalled();
  });

  it('refetches the allowance after a scope failure and then sends only the scope', async () => {
    childAllowance.mockResolvedValueOnce(allowance({ childAgentLimit: 2 }));
    childAllowance.mockResolvedValue(allowance({ childAgentLimit: 4 }));
    setChildGrantScope.mockRejectedValueOnce(new Error('scope failed'));
    renderCard();

    fireEvent.change(await screen.findByLabelText(text('agents.allowance.limitLabel')), { target: { value: '4' } });
    fireEvent.click(screen.getByLabelText(SKILLS_LABEL));
    fireEvent.click(screen.getByRole('button', { name: text('agents.allowance.save') }));

    await waitFor(() => expect(childAllowance).toHaveBeenCalledTimes(2));
    expect(setChildLimit).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(text('common.errorTitle'))).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: text('agents.allowance.save') }));

    await waitFor(() => expect(setChildGrantScope).toHaveBeenCalledTimes(2));
    expect(setChildLimit).toHaveBeenCalledTimes(1);
    expect(setChildGrantScope).toHaveBeenLastCalledWith('agent-1', {
      grantAnySkillToChildren: true,
      grantAnyConnectionToChildren: false,
    });
  });

  it('renders nothing when the plan ceiling is 0', () => {
    childAllowance.mockResolvedValue(allowance());
    renderCard(0);

    expect(screen.queryByLabelText(SKILLS_LABEL)).toBeNull();
    expect(childAllowance).not.toHaveBeenCalled();
  });
});
