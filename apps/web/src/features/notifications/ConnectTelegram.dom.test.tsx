// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { IntlProvider } from 'react-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import { auth, type MeResponse, type TelegramLinkResponse } from '../../lib/api-client.js';
import { ConnectTelegram } from './ConnectTelegram.js';
import { TELEGRAM_LINK_POLL_INTERVAL_MS } from './telegram-link-poll.js';

vi.mock('../../lib/api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api-client.js')>();
  return {
    ...actual,
    auth: { ...actual.auth, me: vi.fn(), linkTelegram: vi.fn(), updateMe: vi.fn() },
  };
});

const LINK_URL = 'https://t.me/OpenAIdomBot?start=link_abc';
const UNLINKED = { chatAddresses: [] } as unknown as MeResponse;
const LINKED = {
  chatAddresses: [{ provider: 'telegram', address: '123456789', scope: 'user', status: 'active' }],
} as unknown as MeResponse;

function text(id: string): string {
  const value = messages[id];
  if (value === undefined) {
    throw new Error(`missing message ${id}`);
  }
  return value;
}

const CONNECT = text('settings.telegram.connect');
const CONNECTED = text('settings.telegram.connected');
const CONNECTING = text('settings.telegram.connecting');
const OPEN_TELEGRAM = text('settings.telegram.openTelegram');
const POPUP_BLOCKED = text('settings.telegram.popupBlocked');
const GENERIC_ERROR = text('settings.telegram.error');

interface FakeTab {
  closed: boolean;
  opener: unknown;
  location: { href: string };
  close: ReturnType<typeof vi.fn>;
}

function makeTab(): FakeTab {
  const tab: FakeTab = { closed: false, opener: undefined, location: { href: 'about:blank' }, close: vi.fn() };
  tab.close.mockImplementation(() => {
    tab.closed = true;
  });
  return tab;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Advances fake time and flushes React Query's timer-based notifications and pending promises. */
async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function renderConnect() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <IntlProvider locale="en" messages={messages} defaultLocale="en">
        <ConnectTelegram />
      </IntlProvider>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

function clickConnect() {
  fireEvent.click(screen.getByRole('button', { name: CONNECT }));
}

function meCalls(): unknown[][] {
  return vi.mocked(auth.me).mock.calls;
}

let linked: boolean;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  linked = false;
  vi.mocked(auth.me).mockImplementation(async () => (linked ? LINKED : UNLINKED));
  vi.mocked(auth.linkTelegram).mockResolvedValue({ url: LINK_URL } as TelegramLinkResponse);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('ConnectTelegram (DOM)', () => {
  it('connect click requests a link, opens a blank tab, and moves to connecting', async () => {
    const tab = makeTab();
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    renderConnect();
    await settle();

    clickConnect();
    await settle();

    expect(open).toHaveBeenCalledWith('about:blank', '_blank');
    expect(auth.linkTelegram).toHaveBeenCalledTimes(1);
    expect(tab.opener).toBeNull();
    expect(tab.location.href).toBe(LINK_URL);
    expect(tab.close).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain(CONNECTING);
    expect(screen.getByRole('link', { name: OPEN_TELEGRAM }).getAttribute('href')).toBe(LINK_URL);
    expect(screen.queryByRole('button', { name: CONNECT })).toBeNull();
  });

  it('poll resolves linked: shows connected and writes the linked profile to the me cache', async () => {
    vi.spyOn(window, 'open').mockReturnValue(makeTab() as unknown as Window);
    const { queryClient } = renderConnect();
    await settle();
    clickConnect();
    await settle();

    linked = true;
    await settle(TELEGRAM_LINK_POLL_INTERVAL_MS);

    expect(screen.getByRole('status').textContent).toContain(CONNECTED);
    expect(queryClient.getQueryData(['me'])).toEqual(LINKED);
  });

  it('linked flips true from the me query while connecting: resets to idle, aborts the poll, and stops polling', async () => {
    vi.spyOn(window, 'open').mockReturnValue(makeTab() as unknown as Window);
    const { queryClient } = renderConnect();
    await settle();
    clickConnect();
    await settle();
    // One poll request goes out while still unlinked, so its signal can be checked after the flow is dropped.
    await settle(TELEGRAM_LINK_POLL_INTERVAL_MS);
    const pollSignal = meCalls()[1]?.[0] as AbortSignal;
    expect(pollSignal).toBeInstanceOf(AbortSignal);
    expect(pollSignal.aborted).toBe(false);

    act(() => {
      queryClient.setQueryData(['me'], LINKED);
    });
    await settle();

    expect(pollSignal.aborted).toBe(true);
    expect(screen.getByRole('status').textContent).toContain(CONNECTED);
    const callsAfterLink = meCalls().length;
    await settle(TELEGRAM_LINK_POLL_INTERVAL_MS * 10);
    expect(meCalls().length).toBe(callsAfterLink);
  });

  it('disconnect after the external link shows idle, not connecting, and does not start polling', async () => {
    vi.spyOn(window, 'open').mockReturnValue(makeTab() as unknown as Window);
    const { queryClient } = renderConnect();
    await settle();
    clickConnect();
    await settle();
    act(() => {
      queryClient.setQueryData(['me'], LINKED);
    });
    await settle();
    const callsWhileLinked = meCalls().length;

    act(() => {
      queryClient.setQueryData(['me'], UNLINKED);
    });
    await settle();

    expect(screen.queryByText(CONNECTING)).toBeNull();
    expect(screen.queryByText(CONNECTED)).toBeNull();
    expect(screen.getByRole('button', { name: CONNECT })).toBeTruthy();
    await settle(TELEGRAM_LINK_POLL_INTERVAL_MS * 10);
    expect(meCalls().length).toBe(callsWhileLinked);
  });

  it('linked externally while the link request is pending: closes the blank tab and ignores the late response', async () => {
    const tab = makeTab();
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    const link = deferred<TelegramLinkResponse>();
    vi.mocked(auth.linkTelegram).mockReturnValueOnce(link.promise);
    const { queryClient } = renderConnect();
    await settle();
    clickConnect();
    await settle();
    expect(tab.close).not.toHaveBeenCalled();

    act(() => {
      queryClient.setQueryData(['me'], LINKED);
    });
    await settle();
    expect(tab.close).toHaveBeenCalledTimes(1);

    await act(async () => {
      link.resolve({ url: LINK_URL } as TelegramLinkResponse);
    });
    await settle();

    expect(tab.location.href).toBe('about:blank');
    expect(screen.queryByRole('link', { name: OPEN_TELEGRAM })).toBeNull();
    expect(screen.getByRole('status').textContent).toContain(CONNECTED);
  });

  it('popup blocked: shows the fallback link and moves focus to it', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    renderConnect();
    await settle();

    clickConnect();
    await settle();

    expect(screen.getByRole('status').textContent).toContain(POPUP_BLOCKED);
    const link = screen.getByRole('link', { name: OPEN_TELEGRAM });
    expect(link.getAttribute('href')).toBe(LINK_URL);
    expect(document.activeElement).toBe(link);
  });

  it('invalid link URL from the API: closes the blank tab, shows the error, and does not poll', async () => {
    const tab = makeTab();
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    vi.mocked(auth.linkTelegram).mockResolvedValueOnce({ url: 'https://evil.example/phish' } as TelegramLinkResponse);
    renderConnect();
    await settle();
    const callsBeforeClick = meCalls().length;

    clickConnect();
    await settle();

    expect(tab.close).toHaveBeenCalledTimes(1);
    expect(tab.location.href).toBe('about:blank');
    expect(screen.getByRole('status').textContent).toContain(GENERIC_ERROR);
    expect(document.activeElement).toBe(screen.getByRole('status'));
    expect(screen.getByRole('button', { name: CONNECT })).toBeTruthy();
    await settle(TELEGRAM_LINK_POLL_INTERVAL_MS * 3);
    expect(meCalls().length).toBe(callsBeforeClick);
  });

  it('unmount while connecting aborts the poll and makes no further me requests', async () => {
    vi.spyOn(window, 'open').mockReturnValue(makeTab() as unknown as Window);
    const { unmount } = renderConnect();
    await settle();
    clickConnect();
    await settle();
    await settle(TELEGRAM_LINK_POLL_INTERVAL_MS);
    const pollSignal = meCalls()[1]?.[0] as AbortSignal;

    unmount();

    expect(pollSignal.aborted).toBe(true);
    const callsAtUnmount = meCalls().length;
    await settle(TELEGRAM_LINK_POLL_INTERVAL_MS * 10);
    expect(meCalls().length).toBe(callsAtUnmount);
  });

  it('unmount while the link request is pending closes the blank tab', async () => {
    const tab = makeTab();
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    vi.mocked(auth.linkTelegram).mockReturnValueOnce(deferred<TelegramLinkResponse>().promise);
    const { unmount } = renderConnect();
    await settle();
    clickConnect();
    await settle();

    unmount();

    expect(tab.close).toHaveBeenCalledTimes(1);
  });

  it('unmount leaves a tab that has navigated away from about:blank open', async () => {
    const tab = makeTab();
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    vi.mocked(auth.linkTelegram).mockReturnValueOnce(deferred<TelegramLinkResponse>().promise);
    const { unmount } = renderConnect();
    await settle();
    clickConnect();
    await settle();
    tab.location.href = LINK_URL;

    unmount();

    expect(tab.close).not.toHaveBeenCalled();
  });
});
