import { ApiError, type PushConfigResponse, type PushSubscriptionBody, type PushSubscriptionCreated } from '../api-client.js';

/** Browser PushSubscription surface used here. Real PushSubscription values satisfy it. */
export interface PushSubscriptionLike {
  toJSON(): { endpoint?: string; keys?: Partial<Record<'p256dh' | 'auth', string>> };
  options?: { applicationServerKey: ArrayBuffer | null };
  unsubscribe(): Promise<boolean>;
}

export interface PushManagerLike {
  getSubscription(): Promise<PushSubscriptionLike | null>;
  subscribe(options: { userVisibleOnly: true; applicationServerKey: Uint8Array<ArrayBuffer> }): Promise<PushSubscriptionLike>;
}

/** Everything the flow touches. Tests inject a mocked PushManager and fake API calls. */
export interface PushFlowDeps {
  requestPermission(): Promise<string>;
  fetchConfig(): Promise<PushConfigResponse>;
  getPushManager(): Promise<PushManagerLike>;
  saveSubscription(body: PushSubscriptionBody): Promise<PushSubscriptionCreated>;
  revokeSubscription(id: string): Promise<void>;
  subscriptionIds: { read(): string | null; write(id: string): void; clear(): void };
}

export type PushEnableOutcome =
  | { kind: 'subscribed' }
  | { kind: 'permission_denied' }
  | { kind: 'permission_dismissed' }
  | { kind: 'unavailable' }
  | { kind: 'failed'; code: string };

export const PUSH_ERROR_CODES = {
  unavailable: 'push.unavailable',
  subscriptionIncomplete: 'push.subscription_incomplete',
  subscribeFailed: 'push.subscribe_failed',
  revokeFailed: 'push.revoke_failed',
} as const;

/** Converts the base64url VAPID public key into the byte form PushManager.subscribe expects. */
export function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padded = base64Url + '='.repeat((4 - (base64Url.length % 4)) % 4);
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function toSubscriptionBody(subscription: PushSubscriptionLike): PushSubscriptionBody | null {
  const json = subscription.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) return null;
  return { endpoint: json.endpoint, keys: { p256dh, auth } };
}

function errorCode(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.code : fallback;
}

/** A subscription made with another VAPID key cannot receive pushes from this server. An unreported key is kept as-is. */
function hasServerKey(subscription: PushSubscriptionLike, expected: Uint8Array<ArrayBuffer>): boolean {
  const current = subscription.options?.applicationServerKey;
  if (current === undefined) return true;
  if (current === null || current.byteLength !== expected.byteLength) return false;
  const bytes = new Uint8Array(current);
  return bytes.every((byte, index) => byte === expected[index]);
}

/**
 * Runs only from the user's opt-in button. Permission is requested here and nowhere on page load (081 W8).
 */
export async function enablePush(deps: PushFlowDeps): Promise<PushEnableOutcome> {
  const permission = await deps.requestPermission();
  if (permission === 'denied') return { kind: 'permission_denied' };
  if (permission !== 'granted') return { kind: 'permission_dismissed' };

  const config = await deps.fetchConfig();
  if (!config.enabled || !config.vapidPublicKey) {
    return { kind: 'unavailable' };
  }

  try {
    const manager = await deps.getPushManager();
    const applicationServerKey = urlBase64ToUint8Array(config.vapidPublicKey);
    const existing = await manager.getSubscription();
    let subscription: PushSubscriptionLike;
    if (existing && hasServerKey(existing, applicationServerKey)) {
      subscription = existing;
    } else {
      if (existing) await existing.unsubscribe();
      subscription = await manager.subscribe({ userVisibleOnly: true, applicationServerKey });
    }

    const body = toSubscriptionBody(subscription);
    if (!body) return { kind: 'failed', code: PUSH_ERROR_CODES.subscriptionIncomplete };

    const saved = await deps.saveSubscription(body);
    deps.subscriptionIds.write(saved.subscription.id);
    return { kind: 'subscribed' };
  } catch (error) {
    return { kind: 'failed', code: errorCode(error, PUSH_ERROR_CODES.subscribeFailed) };
  }
}

/**
 * Revokes the server row first, then the browser subscription. If the server call fails the browser keeps its
 * subscription, so the user can retry. Without a stored id the browser unsubscribes, and the push service's
 * 410 later revokes the row (081 W4).
 */
export async function disablePush(deps: PushFlowDeps): Promise<void> {
  const id = deps.subscriptionIds.read();
  if (id !== null) {
    try {
      await deps.revokeSubscription(id);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
  }
  const manager = await deps.getPushManager();
  const subscription = await manager.getSubscription();
  if (subscription) await subscription.unsubscribe();
  deps.subscriptionIds.clear();
}

/**
 * Unsubscribes this browser so the next enablePush creates a new endpoint. Used only after an explicit user action
 * when the endpoint belongs to another account, so no server row is touched here.
 */
export async function clearBrowserSubscription(deps: PushFlowDeps): Promise<void> {
  const manager = await deps.getPushManager();
  const subscription = await manager.getSubscription();
  if (subscription) await subscription.unsubscribe();
  deps.subscriptionIds.clear();
}
