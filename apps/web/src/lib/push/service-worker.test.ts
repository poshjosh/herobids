import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const APP_ORIGIN = 'https://app.example.test';
const source = readFileSync(new URL('../../../public/sw.js', import.meta.url), 'utf8');

interface PushEventLike {
  data?: { json(): unknown };
  waitUntil(promise: Promise<unknown>): void;
}

interface ClickEventLike {
  notification: { data?: { url?: unknown }; close(): void };
  waitUntil(promise: Promise<unknown>): void;
}

function loadWorker() {
  const listeners = new Map<string, (event: unknown) => void>();
  const showNotification = vi.fn(async () => undefined);
  const focus = vi.fn(async () => undefined);
  const navigate = vi.fn(async () => null);
  const openWindow = vi.fn(async () => null);
  const clientsList: Array<{ url: string; focus: typeof focus; navigate: typeof navigate }> = [];
  const fakeSelf = {
    location: { origin: APP_ORIGIN },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, listener);
    },
    registration: { showNotification },
    clients: {
      matchAll: vi.fn(async () => clientsList),
      openWindow,
    },
  };
  runInNewContext(source, { self: fakeSelf, URL });

  function dispatch(type: 'push' | 'notificationclick', event: object): Promise<unknown[]> {
    const pending: Promise<unknown>[] = [];
    const listener = listeners.get(type);
    if (!listener) throw new Error(`no ${type} listener`);
    listener({ ...event, waitUntil: (promise: Promise<unknown>) => pending.push(promise) });
    return Promise.all(pending);
  }

  return { listeners, showNotification, openWindow, focus, navigate, clientsList, dispatch };
}

describe('public/sw.js', () => {
  it('handles only push and notificationclick, with no fetch handler or caching', () => {
    const { listeners } = loadWorker();

    expect([...listeners.keys()].sort()).toEqual(['notificationclick', 'push']);
    expect(source).not.toMatch(/caches\./);
  });

  it('shows the agent name and the fixed body, never message text', async () => {
    const worker = loadWorker();
    const event: PushEventLike = {
      data: { json: () => ({ title: 'Research Agent', body: 'secret message text', url: '/agents/a1' }) },
      waitUntil: () => undefined,
    };

    await worker.dispatch('push', event);

    expect(worker.showNotification).toHaveBeenCalledWith('Research Agent', {
      body: 'You have a new message',
      data: { url: '/agents/a1' },
    });
  });

  it('still shows a visible notification when the payload is not JSON', async () => {
    const worker = loadWorker();
    const event = { data: { json: () => { throw new SyntaxError('bad'); } } };

    await worker.dispatch('push', event);

    expect(worker.showNotification).toHaveBeenCalledWith('OpenAIdom', {
      body: 'You have a new message',
      data: { url: '/' },
    });
  });

  it('still shows a visible notification when the JSON payload is null', async () => {
    const worker = loadWorker();
    const event = { data: { json: () => null } };

    await worker.dispatch('push', event);

    expect(worker.showNotification).toHaveBeenCalledWith('OpenAIdom', {
      body: 'You have a new message',
      data: { url: '/' },
    });
  });

  it('opens a same-origin agent URL from the notification data', async () => {
    const worker = loadWorker();
    const event: ClickEventLike = {
      notification: { data: { url: '/agents/a1' }, close: () => undefined },
      waitUntil: () => undefined,
    };

    await worker.dispatch('notificationclick', event);

    expect(worker.openWindow).toHaveBeenCalledWith('/agents/a1');
  });

  it.each([
    ['an absolute URL on another origin', 'https://evil.example.test/agents/a1'],
    ['a protocol-relative URL', '//evil.example.test/agents/a1'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a non-string value', 42],
  ])('opens the app root for %s', async (_label, url) => {
    const worker = loadWorker();
    const event: ClickEventLike = {
      notification: { data: { url }, close: () => undefined },
      waitUntil: () => undefined,
    };

    await worker.dispatch('notificationclick', event);

    expect(worker.openWindow).toHaveBeenCalledWith('/');
  });

  it('focuses an open same-origin window and navigates it to the agent', async () => {
    const worker = loadWorker();
    worker.clientsList.push({ url: `${APP_ORIGIN}/settings`, focus: worker.focus, navigate: worker.navigate });
    const event: ClickEventLike = {
      notification: { data: { url: '/agents/a1' }, close: () => undefined },
      waitUntil: () => undefined,
    };

    await worker.dispatch('notificationclick', event);

    expect(worker.focus).toHaveBeenCalledTimes(1);
    expect(worker.navigate).toHaveBeenCalledWith('/agents/a1');
    expect(worker.openWindow).not.toHaveBeenCalled();
  });
});
