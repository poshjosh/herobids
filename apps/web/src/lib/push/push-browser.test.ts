import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserPushDeps } from './push-browser.js';

const SERVICE_WORKER_READY_TIMEOUT_MS = 10_000;

function stubServiceWorker(serviceWorker: object): void {
  vi.stubGlobal('navigator', { serviceWorker });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('createBrowserPushDeps().getPushManager', () => {
  it('returns the push manager of the active registration', async () => {
    const pushManager = { getSubscription: vi.fn(), subscribe: vi.fn() };
    stubServiceWorker({
      getRegistration: vi.fn(async () => ({})),
      ready: Promise.resolve({ pushManager }),
    });

    await expect(createBrowserPushDeps().getPushManager()).resolves.toBe(pushManager);
  });

  it('fails with a clear error when registration failed, without waiting on ready', async () => {
    const ready = new Promise<never>(() => undefined);
    stubServiceWorker({
      getRegistration: vi.fn(async () => undefined),
      ready,
    });

    await expect(createBrowserPushDeps().getPushManager()).rejects.toThrow('Service worker is not registered');
  });

  it('gives up when a registration never becomes active', async () => {
    vi.useFakeTimers();
    stubServiceWorker({
      getRegistration: vi.fn(async () => ({})),
      ready: new Promise<never>(() => undefined),
    });

    const pending = createBrowserPushDeps().getPushManager();
    const assertion = expect(pending).rejects.toThrow('Service worker did not become active in time');
    await vi.advanceTimersByTimeAsync(SERVICE_WORKER_READY_TIMEOUT_MS);

    await assertion;
  });
});
