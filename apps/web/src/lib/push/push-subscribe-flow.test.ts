import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api-client.js';
import {
  disablePush,
  enablePush,
  PUSH_ERROR_CODES,
  clearBrowserSubscription,
  urlBase64ToUint8Array,
  type PushFlowDeps,
  type PushSubscriptionLike,
} from './push-subscribe-flow.js';

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/device-1';
const VAPID_PUBLIC = Buffer.alloc(65, 4).toString('base64url');

function makeSubscription(keys: { p256dh?: string; auth?: string } | null = { p256dh: 'P256DH', auth: 'AUTH' }): PushSubscriptionLike & { unsubscribe: ReturnType<typeof vi.fn> } {
  return {
    toJSON: () => ({ endpoint: ENDPOINT, keys: keys ?? undefined }),
    unsubscribe: vi.fn(async () => true),
  };
}

interface Harness {
  deps: PushFlowDeps;
  manager: {
    getSubscription: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
  subscription: ReturnType<typeof makeSubscription>;
  saveSubscription: ReturnType<typeof vi.fn>;
  revokeSubscription: ReturnType<typeof vi.fn>;
  requestPermission: ReturnType<typeof vi.fn>;
  stored: { id: string | null };
}

function makeHarness(options: { existing?: boolean; keys?: { p256dh?: string; auth?: string } | null } = {}): Harness {
  const subscription = makeSubscription(options.keys === undefined ? { p256dh: 'P256DH', auth: 'AUTH' } : options.keys);
  const manager = {
    getSubscription: vi.fn(async () => (options.existing ? subscription : null)),
    subscribe: vi.fn(async () => subscription),
  };
  const stored: { id: string | null } = { id: null };
  const saveSubscription = vi.fn(async () => ({ subscription: { id: 'ps-1', createdAt: '2026-10-24T10:00:00.000Z' } }));
  const revokeSubscription = vi.fn(async () => undefined);
  const requestPermission = vi.fn(async () => 'granted');
  const deps: PushFlowDeps = {
    requestPermission,
    fetchConfig: vi.fn(async () => ({ enabled: true, vapidPublicKey: VAPID_PUBLIC })),
    getPushManager: vi.fn(async () => manager),
    saveSubscription,
    revokeSubscription,
    subscriptionIds: {
      read: () => stored.id,
      write: (id) => {
        stored.id = id;
      },
      clear: () => {
        stored.id = null;
      },
    },
  };
  return { deps, manager, subscription, saveSubscription, revokeSubscription, requestPermission, stored };
}

describe('urlBase64ToUint8Array', () => {
  it('decodes url-safe base64 into the exact bytes', () => {
    const bytes = [251, 255, 191];
    expect(Array.from(urlBase64ToUint8Array(Buffer.from(bytes).toString('base64url')))).toEqual(bytes);
  });
});

describe('enablePush', () => {
  it('requests permission, subscribes with the server key, saves the endpoint, and stores the row id', async () => {
    const h = makeHarness();

    const outcome = await enablePush(h.deps);

    expect(outcome).toEqual({ kind: 'subscribed' });
    expect(h.requestPermission).toHaveBeenCalledTimes(1);
    expect(h.manager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: expect.any(Uint8Array),
    });
    expect(h.saveSubscription).toHaveBeenCalledWith({ endpoint: ENDPOINT, keys: { p256dh: 'P256DH', auth: 'AUTH' } });
    expect(h.stored.id).toBe('ps-1');
  });

  it('reuses an existing browser subscription instead of subscribing again', async () => {
    const h = makeHarness({ existing: true });

    await enablePush(h.deps);

    expect(h.manager.subscribe).not.toHaveBeenCalled();
    expect(h.saveSubscription).toHaveBeenCalledTimes(1);
  });

  it('reuses a browser subscription that was made with the current server key', async () => {
    const h = makeHarness({ existing: true });
    h.subscription.options = { applicationServerKey: new Uint8Array(65).fill(4).buffer };

    await enablePush(h.deps);

    expect(h.subscription.unsubscribe).not.toHaveBeenCalled();
    expect(h.manager.subscribe).not.toHaveBeenCalled();
    expect(h.saveSubscription).toHaveBeenCalledTimes(1);
  });

  it('replaces a browser subscription made with a rotated VAPID key', async () => {
    const h = makeHarness({ existing: true });
    h.subscription.options = { applicationServerKey: new Uint8Array(65).fill(7).buffer };
    const replacement = makeSubscription();
    h.manager.subscribe.mockResolvedValueOnce(replacement);

    expect(await enablePush(h.deps)).toEqual({ kind: 'subscribed' });

    expect(h.subscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(h.manager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC),
    });
    expect(h.saveSubscription).toHaveBeenCalledWith({ endpoint: ENDPOINT, keys: { p256dh: 'P256DH', auth: 'AUTH' } });
  });

  it('stops at denied permission without fetching config or subscribing', async () => {
    const h = makeHarness();
    h.requestPermission.mockResolvedValueOnce('denied');

    const outcome = await enablePush(h.deps);

    expect(outcome).toEqual({ kind: 'permission_denied' });
    expect(h.deps.fetchConfig).not.toHaveBeenCalled();
    expect(h.manager.subscribe).not.toHaveBeenCalled();
    expect(h.saveSubscription).not.toHaveBeenCalled();
  });

  it('treats a dismissed prompt as no change', async () => {
    const h = makeHarness();
    h.requestPermission.mockResolvedValueOnce('default');

    expect(await enablePush(h.deps)).toEqual({ kind: 'permission_dismissed' });
    expect(h.manager.subscribe).not.toHaveBeenCalled();
  });

  it('reports unavailable and subscribes nothing when the server feature is off', async () => {
    const h = makeHarness();
    h.deps.fetchConfig = vi.fn(async () => ({ enabled: false, vapidPublicKey: null }));

    expect(await enablePush(h.deps)).toEqual({ kind: 'unavailable' });
    expect(h.manager.subscribe).not.toHaveBeenCalled();
    expect(h.saveSubscription).not.toHaveBeenCalled();
  });

  it('reports an incomplete browser subscription without saving it', async () => {
    const h = makeHarness({ keys: null });

    expect(await enablePush(h.deps)).toEqual({ kind: 'failed', code: PUSH_ERROR_CODES.subscriptionIncomplete });
    expect(h.saveSubscription).not.toHaveBeenCalled();
  });

  it('surfaces the endpoint-owned code from a 409 without changing the browser state', async () => {
    const h = makeHarness();
    h.saveSubscription.mockRejectedValueOnce(new ApiError(409, 'notification.endpoint_owned', 'owned'));

    expect(await enablePush(h.deps)).toEqual({ kind: 'failed', code: 'notification.endpoint_owned' });
    expect(h.stored.id).toBeNull();
  });

  it('maps an unexpected save error to the generic subscribe code', async () => {
    const h = makeHarness();
    h.saveSubscription.mockRejectedValueOnce(new Error('network down'));

    expect(await enablePush(h.deps)).toEqual({ kind: 'failed', code: PUSH_ERROR_CODES.subscribeFailed });
  });
});

describe('disablePush', () => {
  it('revokes the stored row first, then unsubscribes the browser', async () => {
    const h = makeHarness({ existing: true });
    h.stored.id = 'ps-1';

    await disablePush(h.deps);

    expect(h.revokeSubscription).toHaveBeenCalledWith('ps-1');
    expect(h.subscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(h.stored.id).toBeNull();
    const revokeOrder = h.revokeSubscription.mock.invocationCallOrder[0] ?? Infinity;
    const unsubscribeOrder = h.subscription.unsubscribe.mock.invocationCallOrder[0] ?? -Infinity;
    expect(revokeOrder).toBeLessThan(unsubscribeOrder);
  });

  it('keeps the browser subscription when the server revoke fails, so the user can retry', async () => {
    const h = makeHarness({ existing: true });
    h.stored.id = 'ps-1';
    h.revokeSubscription.mockRejectedValueOnce(new ApiError(500, 'internal', 'boom'));

    await expect(disablePush(h.deps)).rejects.toBeInstanceOf(ApiError);
    expect(h.subscription.unsubscribe).not.toHaveBeenCalled();
    expect(h.stored.id).toBe('ps-1');
  });

  it('treats an already-gone server row (404) as done and still unsubscribes the browser', async () => {
    const h = makeHarness({ existing: true });
    h.stored.id = 'ps-1';
    h.revokeSubscription.mockRejectedValueOnce(new ApiError(404, 'not_found', 'gone'));

    await disablePush(h.deps);

    expect(h.subscription.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes the browser alone when no row id is stored; the push service 410 revokes the row later', async () => {
    const h = makeHarness({ existing: true });

    await disablePush(h.deps);

    expect(h.revokeSubscription).not.toHaveBeenCalled();
    expect(h.subscription.unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe('clearBrowserSubscription', () => {
  it('unsubscribes the browser and clears the stored row id without touching the server', async () => {
    const h = makeHarness({ existing: true });
    h.stored.id = 'ps-other-account';

    await clearBrowserSubscription(h.deps);

    expect(h.subscription.unsubscribe).toHaveBeenCalledTimes(1);
    expect(h.stored.id).toBeNull();
    expect(h.revokeSubscription).not.toHaveBeenCalled();
    expect(h.saveSubscription).not.toHaveBeenCalled();
  });

  it('lets the next enablePush create a new subscription after a 409', async () => {
    const h = makeHarness({ existing: true });
    h.saveSubscription.mockRejectedValueOnce(new ApiError(409, 'notification.endpoint_owned', 'owned'));
    expect(await enablePush(h.deps)).toEqual({ kind: 'failed', code: 'notification.endpoint_owned' });

    await clearBrowserSubscription(h.deps);
    h.manager.getSubscription.mockResolvedValueOnce(null);
    const fresh = makeSubscription();
    h.manager.subscribe.mockResolvedValueOnce(fresh);

    expect(await enablePush(h.deps)).toEqual({ kind: 'subscribed' });
    expect(h.manager.subscribe).toHaveBeenCalledTimes(1);
    expect(h.stored.id).toBe('ps-1');
  });
});
