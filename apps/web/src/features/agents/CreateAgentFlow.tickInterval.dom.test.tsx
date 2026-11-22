// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IntlProvider } from 'react-intl';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import { ApiError, type MeResponse } from '../../lib/api-client.js';

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

// Stands in for the real picker. The picked ids are NOT in the form's `skills` prop,
// mirroring a skill chosen through the picker's search (2026-11-22 incident).
vi.mock('./SkillPicker.js', () => ({
  SkillPicker: (props: { onChange: (skillIds: string[]) => void }) => (
    <>
      <button type="button" onClick={() => props.onChange(['searched-trading-skill'])}>pick searched skill</button>
      <button type="button" onClick={() => props.onChange([])}>clear skills</button>
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

const DEFAULT_HINT = text('agents.controls.tickInterval.defaultHint');
const MAX_HOLD_API_MESSAGE =
  'maxHoldDurationMs (600000ms) must be >= tickIntervalMs (86400000ms). Set maxHoldDurationMs to at least the tick interval, or reduce tickIntervalMs.';

function renderFlow(initialEntry = '/') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <IntlProvider locale="en" messages={messages}>
          <CreateAgentFlow skills={[]} skillsLoading={false} skillsError={null} onClose={vi.fn()} onCreated={vi.fn()} />
        </IntlProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function tickInput(): HTMLInputElement {
  return document.querySelector('[data-field="tickIntervalMins"] input[type="number"]') as HTMLInputElement;
}

function maxHoldInput(): HTMLInputElement {
  return document.getElementById('rp-maxHoldDurationMs') as HTMLInputElement;
}

async function pickSearchedSkill() {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(text('agents.create.skills.addLabel')) }));
  fireEvent.click(await screen.findByRole('button', { name: 'pick searched skill' }));
}

async function submitCreate() {
  fireEvent.click(screen.getByRole('button', { name: text('agents.create.review') }));
  fireEvent.click(await screen.findByRole('button', { name: text('agents.createAgent') }));
}

async function createAndGetBody(): Promise<Record<string, unknown>> {
  await submitCreate();
  await waitFor(() => expect(createAgent).toHaveBeenCalledTimes(1));
  return createAgent.mock.calls[0]![0] as Record<string, unknown>;
}

beforeEach(() => {
  createAgent.mockResolvedValue({ id: 'agent-new' });
  vi.mocked(auth.me).mockResolvedValue({
    id: 'user-1',
    isAdmin: false,
    email: 'a@example.com',
    chatAddresses: [],
    planEntitlements: { limits: { childAgentLimitCeiling: 0 } },
  } as unknown as MeResponse);
});

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  vi.clearAllMocks();
});

describe('CreateAgentFlow tick interval', () => {
  it('starts with an empty tick interval and the generic default hint, with no number', () => {
    renderFlow();
    expect(tickInput().value).toBe('');
    const hint = screen.getByText(DEFAULT_HINT);
    expect(hint.textContent).not.toMatch(/\d/);
    expect(tickInput().getAttribute('aria-describedby')).toBe(hint.id);
  });

  it('omits tickIntervalMs and max-hold overrides from the payload when the field is empty', async () => {
    renderFlow();
    const body = await createAndGetBody();
    expect(body).not.toHaveProperty('tickIntervalMs');
    expect(body.runtimePolicyOverrides ?? null).toBeNull();
  });

  it('still omits tickIntervalMs when a skill missing from the form skills list is picked via search', async () => {
    renderFlow();
    await pickSearchedSkill();
    expect(tickInput().value).toBe('');
    const body = await createAndGetBody();
    expect(body).toMatchObject({ skillIds: ['searched-trading-skill'] });
    expect(body).not.toHaveProperty('tickIntervalMs');
    expect(body.runtimePolicyOverrides ?? null).toBeNull();
  });

  it('sends an explicit tickIntervalMs when the user types a value', async () => {
    renderFlow();
    fireEvent.change(tickInput(), { target: { value: '15' } });
    expect(screen.queryByText(DEFAULT_HINT)).toBeNull();
    const body = await createAndGetBody();
    expect(body).toMatchObject({ tickIntervalMs: 900_000 });
  });

  it('never writes the tick interval or max hold when the style or skills change', async () => {
    renderFlow();
    fireEvent.change(screen.getByDisplayValue(text('agents.style.balanced.label')), { target: { value: 'bold' } });
    await pickSearchedSkill();
    fireEvent.click(screen.getByRole('button', { name: 'clear skills' }));
    expect(tickInput().value).toBe('');
    expect(maxHoldInput().value).toBe('');
    const body = await createAndGetBody();
    expect(body).not.toHaveProperty('tickIntervalMs');
    expect(body.runtimePolicyOverrides ?? null).toBeNull();
  });

  it('keeps a typed tick interval across style and skill changes without touching max hold', async () => {
    renderFlow();
    fireEvent.change(tickInput(), { target: { value: '1440' } });
    fireEvent.change(screen.getByDisplayValue(text('agents.style.balanced.label')), { target: { value: 'careful' } });
    await pickSearchedSkill();
    expect(tickInput().value).toBe('1440');
    expect(maxHoldInput().value).toBe('');
    const body = await createAndGetBody();
    expect(body).toMatchObject({ tickIntervalMs: 86_400_000 });
    expect(body.runtimePolicyOverrides ?? null).toBeNull();
  });

  it('does not block submit client-side on tick interval versus max hold, and shows the API 400 against the field', async () => {
    createAgent.mockRejectedValue(new ApiError(400, 'validation_error', 'Invalid request', undefined, [
      { path: ['runtimePolicyOverrides', 'maxHoldDurationMs'], message: MAX_HOLD_API_MESSAGE },
    ]));
    renderFlow();
    fireEvent.change(tickInput(), { target: { value: '1440' } });
    fireEvent.change(maxHoldInput(), { target: { value: '10' } });
    await submitCreate();
    await waitFor(() => expect(createAgent).toHaveBeenCalledTimes(1));
    expect(createAgent.mock.calls[0]![0]).toMatchObject({
      tickIntervalMs: 86_400_000,
      runtimePolicyOverrides: { maxHoldDurationMs: 600_000 },
    });

    const error = await screen.findByText(MAX_HOLD_API_MESSAGE);
    expect(error.id).toBe('rp-maxHoldDurationMs-error');
    expect(maxHoldInput().getAttribute('aria-describedby')).toBe(error.id);
    expect(maxHoldInput().getAttribute('aria-invalid')).toBe('true');
    // The error is on the field, not repeated in a generic banner.
    expect(screen.getAllByText(MAX_HOLD_API_MESSAGE)).toHaveLength(1);

    fireEvent.change(maxHoldInput(), { target: { value: '1440' } });
    expect(screen.queryByText(MAX_HOLD_API_MESSAGE)).toBeNull();
  });

  it('hides the cadence and spend estimate while the tick field is empty, and shows it once a value is typed', () => {
    renderFlow();
    expect(screen.queryByText(/Expected cadence/)).toBeNull();
    expect(screen.queryByText(/Estimated daily LLM spend/)).toBeNull();
    fireEvent.change(tickInput(), { target: { value: '15' } });
    expect(screen.getByText(/Base cadence: /)).toBeTruthy();
  });

  it('ignores a legacy v1 OAuth draft so an old 1440 tick and auto-derived max hold are not sent as explicit values', async () => {
    window.sessionStorage.setItem('create-agent-oauth-draft-v1', JSON.stringify({
      step: 'intent',
      intent: {
        tickIntervalMins: '1440',
        runtimePolicyOverrides: { maxHoldDurationMs: 86_400_000 },
      },
      nameIsAutoGenerated: true,
      dailyLossLimitAuto: false,
      policyManuallySet: false,
    }));
    renderFlow('/?oauthReturn=1');
    await waitFor(() => expect(window.sessionStorage.getItem('create-agent-oauth-draft-v1')).toBeNull());
    expect(tickInput().value).toBe('');
    expect(maxHoldInput().value).toBe('');
    const body = await createAndGetBody();
    expect(body).not.toHaveProperty('tickIntervalMs');
    expect(body.runtimePolicyOverrides ?? null).toBeNull();
  });
});
