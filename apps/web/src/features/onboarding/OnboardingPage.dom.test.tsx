// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { IntlProvider } from 'react-intl';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import { agents as agentsApi, type Agent } from '../../lib/api-client.js';
import { OnboardingPage } from './OnboardingPage.js';

vi.mock('../../lib/api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api-client.js')>();
  return {
    ...actual,
    agents: {
      ...actual.agents,
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      start: vi.fn(),
    },
  };
});

vi.mock('../notifications/NotificationsBlock.js', () => ({
  NotificationsBlock: (props: { onSetupAction?: () => void; onSettled?: () => void }) => (
    <div data-testid="telegram-setup">
      <button type="button" onClick={() => props.onSetupAction?.()}>mock-setup-action</button>
      <button type="button" onClick={() => props.onSettled?.()}>mock-settled</button>
    </div>
  ),
}));

function t(key: string): string {
  const value = messages[key];
  if (value === undefined) throw new Error(`Missing en message: ${key}`);
  return value;
}

const newAgent = {
  id: 'agent-1',
  name: 'Alex',
  prompt: '',
  skillIds: [],
  status: 'starting',
} as unknown as Agent;

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function renderPage(search = '') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages}>
        <MemoryRouter initialEntries={[`/onboarding${search}`]}>

          <Routes>
            <Route path="/onboarding" element={<OnboardingPage />} />
            <Route path="/agents" element={<div data-testid="agents-page" />} />
          </Routes>
        </MemoryRouter>
      </IntlProvider>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

function nameInput(): HTMLElement {
  return screen.getByLabelText(t('onboarding.nameLabel'));
}

async function submitName(value: string) {
  fireEvent.change(nameInput(), { target: { value } });
  fireEvent.submit(nameInput().closest('form') as HTMLFormElement);
  await flush();
}

function bubbleCount(): number {
  return document.querySelectorAll('.try-page-bubble').length;
}

function skipButton(): HTMLElement | null {
  return screen.queryByRole('button', { name: t('onboarding.pauseSkip') });
}

describe('OnboardingPage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(agentsApi.list).mockResolvedValue([]);
    vi.mocked(agentsApi.create).mockResolvedValue(newAgent);
    vi.mocked(agentsApi.start).mockResolvedValue({ status: 'starting', sessionId: 's1' } as never);
    vi.mocked(agentsApi.get).mockResolvedValue({ ...newAgent, status: 'starting' });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('sends users with existing agents to the agents page', async () => {
    vi.mocked(agentsApi.list).mockResolvedValue([newAgent]);
    renderPage();
    await flush();
    expect(screen.getByTestId('agents-page')).toBeTruthy();
  });

  it('asks for a name first and does not create an agent until one is entered', async () => {
    renderPage();
    await flush();
    expect(screen.getByText(t('onboarding.askName'))).toBeTruthy();
    expect(agentsApi.create).not.toHaveBeenCalled();
  });

  it('rejects reserved names without calling the API', async () => {
    renderPage();
    await flush();
    await submitName(' all ');
    expect(screen.getByText(t('onboarding.nameInvalid'))).toBeTruthy();
    expect(agentsApi.create).not.toHaveBeenCalled();
  });

  it('creates the agent with the trimmed name and starts it', async () => {
    renderPage();
    await flush();
    await submitName('  Alex  ');
    expect(agentsApi.create).toHaveBeenCalledWith({ name: 'Alex' });
    expect(agentsApi.start).toHaveBeenCalledWith('agent-1');
  });

  it('refreshes the cached agents list after create so /agents does not show the create form', async () => {
    vi.mocked(agentsApi.list).mockResolvedValueOnce([]).mockResolvedValue([newAgent]);
    const { queryClient } = renderPage();
    await flush();
    expect(queryClient.getQueryData(['agents'])).toEqual([]);
    await submitName('Alex');
    expect(agentsApi.list).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryData(['agents'])).toEqual([newAgent]);
  });

  it('writes the active status into the cached agents list before redirecting', async () => {
    const activeAgent = { ...newAgent, status: 'active' };
    vi.mocked(agentsApi.list).mockResolvedValueOnce([]).mockResolvedValue([activeAgent]);
    vi.mocked(agentsApi.get).mockResolvedValue(activeAgent);
    const { queryClient } = renderPage();
    await flush();
    await submitName('Alex');
    await advance(5_000);
    expect(queryClient.getQueryData<Agent[]>(['agents'])?.[0]?.status).toBe('active');
  });

  it('shows the creation message 2 seconds after the name is submitted', async () => {
    renderPage();
    await flush();
    await submitName('Alex');
    expect(screen.queryByText(/is being created/)).toBeNull();
    await advance(2_000);
    expect(screen.getByText('Alex (your own personal AI agent) is being created, please wait.')).toBeTruthy();
  });

  it('shows the Telegram step after 12 seconds', async () => {
    renderPage();
    await flush();
    await submitName('Alex');
    await advance(11_000);
    expect(screen.queryByTestId('telegram-setup')).toBeNull();
    await advance(1_000);
    expect(screen.getByTestId('telegram-setup')).toBeTruthy();
  });

  it('shows the redirect notice once the agent is active, then goes to the agents page', async () => {
    renderPage();
    await flush();
    vi.mocked(agentsApi.get).mockResolvedValue({ ...newAgent, status: 'active' });
    await submitName('Alex');

    await advance(4_000);
    expect(screen.queryByText(t('onboarding.redirecting'))).toBeNull();
    await advance(1_000);
    expect(screen.getByText(t('onboarding.redirecting'))).toBeTruthy();
    expect(screen.queryByText(/is being created/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Go to my agents' })).toBeNull();
    expect(screen.queryByTestId('telegram-setup')).toBeNull();
    await advance(2_000);
    expect(screen.getByTestId('agents-page')).toBeTruthy();
  });

  it('shows the stuck warning with a spinner and the agents link at 60 seconds if the agent has not started', async () => {
    renderPage();
    await flush();
    await submitName('Alex');
    await advance(59_000);
    expect(screen.queryByText(t('onboarding.stuckWarning'))).toBeNull();
    await advance(1_000);
    const warning = screen.getByText(t('onboarding.stuckWarning'));
    expect(warning.querySelector('span[aria-hidden="true"]')).toBeTruthy();
    expect(screen.queryByText(/ticket/i)).toBeNull();
    expect(screen.getByRole('link', { name: 'Go to my agents' })).toBeTruthy();
    expect(screen.queryByText(t('onboarding.redirecting'))).toBeNull();
    await advance(90_000);
    expect(screen.getByText(t('onboarding.stuckWarning'))).toBeTruthy();
    expect(screen.queryByTestId('agents-page')).toBeNull();
  });

  it('shows the stuck warning at once when the start request fails', async () => {
    vi.mocked(agentsApi.start).mockRejectedValueOnce(new Error('boom'));
    renderPage();
    await flush();
    await submitName('Alex');
    expect(screen.getByText(t('onboarding.stuckWarning'))).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to my agents' })).toBeTruthy();
  });

  it('shows the stuck warning at once when the agent has crashed', async () => {
    vi.mocked(agentsApi.get).mockResolvedValue({ ...newAgent, status: 'crashed' });
    renderPage();
    await flush();
    await submitName('Alex');
    await advance(5_000);
    expect(screen.getByText(t('onboarding.stuckWarning'))).toBeTruthy();
  });

  it('does not show the warning early when the agent reports stopped', async () => {
    vi.mocked(agentsApi.get).mockResolvedValue({ ...newAgent, status: 'stopped' });
    renderPage();
    await flush();
    await submitName('Alex');
    await advance(59_000);
    expect(screen.queryByText(t('onboarding.stuckWarning'))).toBeNull();
  });

  it('shows the still-starting line before the warning and never shows the chat', async () => {
    renderPage();
    await flush();
    await submitName('Alex');
    await advance(59_000);
    expect(screen.queryByText(t('onboarding.redirecting'))).toBeNull();
    expect(screen.queryByTestId('chat')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Go to my agents' })).toBeNull();
  });

  it('shows the still-starting line once every timed message has appeared, then redirects when the agent is active', async () => {
    renderPage();
    await flush();
    await submitName('Alex');
    await advance(12_000);
    fireEvent.click(skipButton() as HTMLElement);
    await advance(24_000);
    expect(screen.queryByText('Assistant is typing...')).toBeTruthy();
    expect(screen.queryByText('Still starting Alex. This can take up to a minute.')).toBeNull();
    await advance(1_000);
    expect(screen.getByText('Still starting Alex. This can take up to a minute.')).toBeTruthy();
    expect(screen.queryByText('Assistant is typing...')).toBeNull();

    vi.mocked(agentsApi.get).mockResolvedValue({ ...newAgent, status: 'active' });
    await advance(3_000);
    expect(screen.queryByText('Still starting Alex. This can take up to a minute.')).toBeNull();
    expect(screen.getByText(t('onboarding.redirecting'))).toBeTruthy();
  });

  it('keeps polling after an error and redirects once the agent becomes active', async () => {
    vi.mocked(agentsApi.get).mockRejectedValueOnce(new Error('network'));
    renderPage();
    await flush();
    await submitName('Alex');
    await advance(5_000);
    expect(screen.queryByText(t('onboarding.redirecting'))).toBeNull();
    vi.mocked(agentsApi.get).mockResolvedValue({ ...newAgent, status: 'active' });
    await advance(3_000);
    expect(screen.getByText(t('onboarding.redirecting'))).toBeTruthy();
  });

  // TEMP(onboarding-start-delay): tests for the test-only delay query parameter. Remove with the feature.
  it('holds an active agent back until the simulated delay has passed', async () => {
    vi.mocked(agentsApi.get).mockResolvedValue({ ...newAgent, status: 'active' });
    renderPage('?onboardingStartDelay=10');
    await flush();
    await submitName('Alex');
    await advance(8_000);
    expect(screen.queryByText(t('onboarding.redirecting'))).toBeNull();
    await advance(3_000);
    expect(screen.getByText(t('onboarding.redirecting'))).toBeTruthy();
  });

  it('never reports active with onboardingStartDelay=never, so the warning shows after 60 seconds', async () => {
    vi.mocked(agentsApi.get).mockResolvedValue({ ...newAgent, status: 'active' });
    renderPage('?onboardingStartDelay=never');
    await flush();
    await submitName('Alex');
    await advance(59_000);
    expect(screen.queryByText(t('onboarding.redirecting'))).toBeNull();
    await advance(2_000);
    expect(screen.getByText(t('onboarding.stuckWarning'))).toBeTruthy();
    expect(screen.queryByText(t('onboarding.redirecting'))).toBeNull();
  });

  it('shows the create error and keeps the name form so the user can retry', async () => {
    vi.mocked(agentsApi.create).mockRejectedValueOnce(new Error('boom'));
    renderPage();
    await flush();
    await submitName('Alex');
    expect(screen.getByText(t('onboarding.createError'))).toBeTruthy();
    expect(nameInput()).toBeTruthy();
  });

  describe('pause after the setup step', () => {
    it('holds the messages after the Telegram step until the user acts', async () => {
      renderPage();
      await flush();
      await submitName('Alex');
      await advance(12_000);
      expect(screen.getByTestId('telegram-setup')).toBeTruthy();
      const atPause = bubbleCount();
      await advance(40_000);
      expect(bubbleCount()).toBe(atPause);
      expect(screen.queryByText('Assistant is typing...')).toBeNull();
      expect(screen.getByText(t('onboarding.pauseHint'))).toBeTruthy();
    });

    it('resumes on a setup action and keeps the 5 second gap counted from the resume point', async () => {
      renderPage();
      await flush();
      await submitName('Alex');
      await advance(20_000);
      const atPause = bubbleCount();
      fireEvent.click(screen.getByRole('button', { name: 'mock-setup-action' }));
      expect(skipButton()).toBeNull();
      await advance(4_999);
      expect(bubbleCount()).toBe(atPause);
      await advance(1);
      expect(bubbleCount()).toBe(atPause + 1);
    });

    it('resumes when the user skips', async () => {
      renderPage();
      await flush();
      await submitName('Alex');
      await advance(12_000);
      const atPause = bubbleCount();
      fireEvent.click(skipButton() as HTMLElement);
      await advance(5_000);
      expect(bubbleCount()).toBe(atPause + 1);
    });

    it('resumes only once when the setup step settles and the user also acts', async () => {
      renderPage();
      await flush();
      await submitName('Alex');
      await advance(12_000);
      const atPause = bubbleCount();
      fireEvent.click(screen.getByRole('button', { name: 'mock-settled' }));
      await advance(2_000);
      fireEvent.click(screen.getByRole('button', { name: 'mock-setup-action' }));
      await advance(3_000);
      expect(bubbleCount()).toBe(atPause + 1);
    });

    it('redirects during the pause once the agent is active', async () => {
      renderPage();
      await flush();
      await submitName('Alex');
      await advance(12_000);
      vi.mocked(agentsApi.get).mockResolvedValue({ ...newAgent, status: 'active' });
      await advance(3_000);
      expect(screen.getByText(t('onboarding.redirecting'))).toBeTruthy();
      expect(skipButton()).toBeNull();
      expect(screen.queryByRole('link', { name: 'Go to my agents' })).toBeNull();
    });
  });
});
