// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IntlProvider } from 'react-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { messages } from '../../app/i18n/locales/en.js';
import { auth, push, type MeResponse } from '../../lib/api-client.js';
import { NotificationsBlock } from './NotificationsBlock.js';

vi.mock('../../lib/api-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api-client.js')>();
  return {
    ...actual,
    auth: { ...actual.auth, me: vi.fn(), updateMe: vi.fn() },
    push: { ...actual.push, config: vi.fn() },
  };
});

const LINKED = {
  chatAddresses: [{ provider: 'telegram', address: '123456789', scope: 'user', status: 'active' }],
} as unknown as MeResponse;
const UNLINKED = { chatAddresses: [] } as unknown as MeResponse;

const CANCEL = messages['common.cancel'] ?? '';

function renderBlock(me: MeResponse, onSettled?: () => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(auth.me).mockResolvedValue(me);
  vi.mocked(push.config).mockResolvedValue({ enabled: false } as never);
  const ui = (cb?: () => void) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <IntlProvider locale="en" messages={messages} defaultLocale="en">
          <NotificationsBlock variant="page" onSettled={cb} />
        </IntlProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const result = render(ui(onSettled));
  return { ...result, rerenderWith: (cb: () => void) => result.rerender(ui(cb)) };
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  delete (window as { matchMedia?: unknown }).matchMedia;
});

describe('NotificationsBlock onSettled (DOM)', () => {
  it('fires once when the block is already settled on mount, even if the callback identity changes', async () => {
    const onSettled = vi.fn();
    const { rerenderWith } = renderBlock(LINKED, onSettled);
    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));

    rerenderWith(vi.fn());
    await settle();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('does not fire while the block still needs setup', async () => {
    const onSettled = vi.fn();
    renderBlock(UNLINKED, onSettled);
    expect(await screen.findByText(messages['notifications.block.title'] ?? '')).toBeTruthy();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it('fires once when the user cancels the setup block', async () => {
    const onSettled = vi.fn();
    renderBlock(UNLINKED, onSettled);
    fireEvent.click(await screen.findByRole('button', { name: CANCEL }));

    await waitFor(() => expect(onSettled).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(messages['notifications.block.title'] ?? '')).toBeNull();
  });
});
