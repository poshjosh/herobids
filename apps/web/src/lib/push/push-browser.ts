import { push } from '../api-client.js';
import { detectPushEnvironment, type PushEnvironment } from './push-opt-in-state.js';
import type { PushFlowDeps, PushManagerLike } from './push-subscribe-flow.js';

const SUBSCRIPTION_ID_KEY = 'herobids.push.subscriptionId';

/** The subscription id is kept so a later turn-off can revoke the row. Storage failures fall back to browser-only unsubscribe. */
const subscriptionIds: PushFlowDeps['subscriptionIds'] = {
  read() {
    try {
      return localStorage.getItem(SUBSCRIPTION_ID_KEY);
    } catch {
      return null;
    }
  },
  write(id) {
    try {
      localStorage.setItem(SUBSCRIPTION_ID_KEY, id);
    } catch {
      // Storage unavailable: the row is revoked later by the push service's 410.
    }
  },
  clear() {
    try {
      localStorage.removeItem(SUBSCRIPTION_ID_KEY);
    } catch {
      // Nothing to clear when storage is unavailable.
    }
  },
};

/** `ready` never settles when registration failed, so the wait is bounded. */
const SERVICE_WORKER_READY_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function getPushManager(): Promise<PushManagerLike> {
  if ((await navigator.serviceWorker.getRegistration()) === undefined) {
    throw new Error('Service worker is not registered');
  }
  const registration = await withTimeout(
    navigator.serviceWorker.ready,
    SERVICE_WORKER_READY_TIMEOUT_MS,
    'Service worker did not become active in time',
  );
  return registration.pushManager;
}

export function createBrowserPushDeps(): PushFlowDeps {
  return {
    requestPermission: () => Notification.requestPermission(),
    fetchConfig: () => push.config(),
    getPushManager,
    saveSubscription: (body) => push.subscribe(body),
    revokeSubscription: (id) => push.revoke(id),
    subscriptionIds,
  };
}

/** Reads the browser state. It never requests permission. */
export async function readBrowserPushEnvironment(): Promise<PushEnvironment> {
  const hasServiceWorker = 'serviceWorker' in navigator;
  const hasPushManager = 'PushManager' in window;
  const hasNotification = 'Notification' in window;
  // getRegistration does not wait for activation, so a failed or pending worker cannot leave the UI blank.
  let subscribed = false;
  if (hasServiceWorker && hasPushManager) {
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      subscribed = registration !== undefined && (await registration.pushManager.getSubscription()) !== null;
    } catch {
      subscribed = false;
    }
  }
  return detectPushEnvironment({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints,
    navigatorStandalone: 'standalone' in navigator ? navigator.standalone === true : false,
    displayModeStandalone: window.matchMedia('(display-mode: standalone)').matches,
    hasServiceWorker,
    hasPushManager,
    hasNotification,
    permission: hasNotification ? Notification.permission : 'default',
    subscribed,
  });
}
