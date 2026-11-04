// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlProvider } from 'react-intl';
import { messages } from '../../app/i18n/locales/en.js';
import { PushOptIn } from './PushOptIn.js';

const pushState = vi.hoisted(() => ({
  enablePush: vi.fn(),
}));

vi.mock('../../lib/api-client.js', () => ({
  push: { config: vi.fn(async () => ({ enabled: true })) },
}));

vi.mock('../../lib/push/push-browser.js', () => ({
  createBrowserPushDeps: vi.fn(() => ({})),
  readBrowserPushEnvironment: vi.fn(async () => ({
    ios: false,
    standalone: false,
    serviceWorker: true,
    pushManager: true,
    notification: true,
    permission: 'default',
    subscribed: false,
  })),
}));

vi.mock('../../lib/push/push-subscribe-flow.js', () => ({
  clearBrowserSubscription: vi.fn(),
  disablePush: vi.fn(),
  enablePush: pushState.enablePush,
  PUSH_ERROR_CODES: { subscribeFailed: 'subscribe_failed', revokeFailed: 'revoke_failed', unavailable: 'unavailable' },
}));

function renderOptIn(onEnableStart: () => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages} defaultLocale="en">
        <PushOptIn onEnableStart={onEnableStart} />
      </IntlProvider>
    </QueryClientProvider>,
  );
}

describe('PushOptIn (DOM)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pushState.enablePush.mockResolvedValue({ kind: 'subscribed' });
  });

  afterEach(() => {
    cleanup();
  });

  it('calls onEnableStart when the user clicks enable', async () => {
    const onEnableStart = vi.fn();
    renderOptIn(onEnableStart);

    fireEvent.click(await screen.findByRole('button', { name: messages['push.optIn.enable'] }));

    expect(onEnableStart).toHaveBeenCalledTimes(1);
  });
});
