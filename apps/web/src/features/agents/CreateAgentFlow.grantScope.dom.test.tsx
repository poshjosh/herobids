// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IntlProvider } from 'react-intl';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHILD_AGENT_MANAGEMENT_SKILL_ID } from '@herobids/domain';
import { messages } from '../../app/i18n/locales/en.js';
import type { MeResponse } from '../../lib/api-client.js';

const createAgent = vi.fn();

vi.mock('../../lib/api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api-client.js')>();
  return {
    ...actual,
    agents: {
      ...actual.agents,
      create: (body: unknown) => createAgent(body),
      start: vi.fn().mockResolvedValue({}),
      riskDefaults: vi.fn().mockResolvedValue({}),
    },
    auth: { ...actual.auth, me: vi.fn() },
    ai: {
      ...actual.ai,
      settings: vi.fn().mockResolvedValue({ aiModelConfig: null }),
      availableModels: vi.fn().mockResolvedValue({ providers: [] }),
    },
    capabilities: { ...actual.capabilities, tradingConnections: vi.fn().mockResolvedValue({ connections: [] }) },
    connections: { ...actual.connections, list: vi.fn().mockResolvedValue({ connections: [] }) },
    providerCatalog: { ...actual.providerCatalog, get: vi.fn().mockResolvedValue({ providers: [] }) },
  };
});

// The real picker loads skills over the network. The stub toggles the skill set directly.
vi.mock('./SkillPicker.js', () => ({
  SkillPicker: (props: { onChange: (skillIds: string[]) => void }) => (
    <>
      <button type="button" onClick={() => props.onChange([CHILD_AGENT_MANAGEMENT_SKILL_ID])}>pick children skill</button>
      <button type="button" onClick={() => props.onChange(['other-skill'])}>pick other skill</button>
    </>
  ),
}));
vi.mock('../notifications/NotificationsBlock.js', () => ({ NotificationsBlock: () => null }));

import { auth } from '../../lib/api-client.js';
import { CreateAgentFlow } from './CreateAgentFlow.js';

function text(id: string): string {
  const value = messages[id];
  if (value === undefined) throw new Error(`Missing test message: ${id}`);
  return value;
}

const SKILLS_LABEL = text('agents.allowance.grantSkills');
const CONNECTIONS_LABEL = text('agents.allowance.grantConnections');

function mockMe(ceiling: number) {
  vi.mocked(auth.me).mockResolvedValue({
    id: 'user-1',
    isAdmin: false,
    email: 'a@example.com',
    chatAddresses: [],
    planEntitlements: { limits: { childAgentLimitCeiling: ceiling } },
  } as unknown as MeResponse);
}

function renderFlow() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <IntlProvider locale="en" messages={messages}>
          <CreateAgentFlow skills={[]} skillsLoading={false} skillsError={null} onClose={vi.fn()} onCreated={vi.fn()} />
        </IntlProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function pickSkill(name: string) {
  const toggle = screen.getByRole('button', { name: new RegExp(text('agents.create.skills.addLabel')) });
  fireEvent.click(toggle);
  fireEvent.click(await screen.findByRole('button', { name }));
}

async function createAndGetBody(): Promise<Record<string, unknown>> {
  fireEvent.click(screen.getByRole('button', { name: text('agents.create.review') }));
  fireEvent.click(await screen.findByRole('button', { name: text('agents.createAgent') }));
  await waitFor(() => expect(createAgent).toHaveBeenCalledTimes(1));
  return createAgent.mock.calls[0]![0] as Record<string, unknown>;
}

beforeEach(() => {
  createAgent.mockResolvedValue({ id: 'agent-new' });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CreateAgentFlow child grant scope', () => {
  it('shows the checkboxes only when the children skill is selected and the plan allows children', async () => {
    mockMe(3);
    renderFlow();
    await waitFor(() => expect(auth.me).toHaveBeenCalled());
    expect(screen.queryByLabelText(SKILLS_LABEL)).toBeNull();

    await pickSkill('pick other skill');
    expect(screen.queryByLabelText(SKILLS_LABEL)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'pick children skill' }));
    expect(await screen.findByLabelText(SKILLS_LABEL)).toBeTruthy();
    expect(screen.getByLabelText(CONNECTIONS_LABEL).getAttribute('aria-describedby')).toBeTruthy();
  });

  it('hides the checkboxes when the plan ceiling is 0', async () => {
    mockMe(0);
    renderFlow();
    await waitFor(() => expect(auth.me).toHaveBeenCalled());

    await pickSkill('pick children skill');
    expect(screen.queryByLabelText(SKILLS_LABEL)).toBeNull();
  });

  it('sends both flags when the children skill is selected', async () => {
    mockMe(3);
    renderFlow();
    await pickSkill('pick children skill');

    fireEvent.click(await screen.findByLabelText(CONNECTIONS_LABEL));
    const body = await createAndGetBody();

    expect(body).toMatchObject({
      skillIds: [CHILD_AGENT_MANAGEMENT_SKILL_ID],
      grantAnySkillToChildren: false,
      grantAnyConnectionToChildren: true,
    });
  });

  it('omits the flags when the children skill is not selected, even if they were ticked before', async () => {
    mockMe(3);
    renderFlow();
    await pickSkill('pick children skill');
    fireEvent.click(await screen.findByLabelText(SKILLS_LABEL));
    fireEvent.click(screen.getByRole('button', { name: 'pick other skill' }));

    const body = await createAndGetBody();

    expect(body).not.toHaveProperty('grantAnySkillToChildren');
    expect(body).not.toHaveProperty('grantAnyConnectionToChildren');
  });

  it('omits the flags when the plan ceiling is 0', async () => {
    mockMe(0);
    renderFlow();
    await waitFor(() => expect(auth.me).toHaveBeenCalled());
    await pickSkill('pick children skill');

    const body = await createAndGetBody();

    expect(body).not.toHaveProperty('grantAnySkillToChildren');
  });
});
