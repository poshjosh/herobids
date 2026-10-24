import { describe, expect, it } from 'vitest';
import {
  detectPushEnvironment,
  isIosDevice,
  resolvePushOptInState,
  type PushEnvironment,
  type PushEnvironmentFacts,
} from './push-opt-in-state.js';

const SAFARI_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1';
const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36';

const READY: PushEnvironment = {
  serviceWorker: true,
  pushManager: true,
  notification: true,
  ios: false,
  standalone: false,
  permission: 'default',
  subscribed: false,
};

const FACTS: PushEnvironmentFacts = {
  userAgent: CHROME_MAC,
  platform: 'MacIntel',
  maxTouchPoints: 0,
  navigatorStandalone: undefined,
  displayModeStandalone: false,
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
  permission: 'default',
  subscribed: false,
};

describe('isIosDevice', () => {
  it('detects iPhone and iPod user agents', () => {
    expect(isIosDevice(SAFARI_IPHONE, 'iPhone', 5)).toBe(true);
  });

  it('detects iPadOS, which reports a desktop platform with touch points', () => {
    expect(isIosDevice(CHROME_MAC, 'MacIntel', 5)).toBe(true);
  });

  it('does not treat a Mac without touch as iOS', () => {
    expect(isIosDevice(CHROME_MAC, 'MacIntel', 0)).toBe(false);
  });
});

describe('detectPushEnvironment', () => {
  it('marks the app standalone from either the iOS flag or the display-mode media query', () => {
    expect(detectPushEnvironment({ ...FACTS, navigatorStandalone: true }).standalone).toBe(true);
    expect(detectPushEnvironment({ ...FACTS, displayModeStandalone: true }).standalone).toBe(true);
    expect(detectPushEnvironment(FACTS).standalone).toBe(false);
  });

  it('treats an unknown permission value as default', () => {
    expect(detectPushEnvironment({ ...FACTS, permission: 'prompt-later' }).permission).toBe('default');
  });
});

describe('resolvePushOptInState', () => {
  it('is ready when push is available and not yet on', () => {
    expect(resolvePushOptInState(READY, null)).toBe('ready');
  });

  it('is subscribed when this browser holds a subscription', () => {
    expect(resolvePushOptInState({ ...READY, permission: 'granted', subscribed: true }, null)).toBe('subscribed');
  });

  it('is permission_denied when the browser blocks notifications', () => {
    expect(resolvePushOptInState({ ...READY, permission: 'denied' }, null)).toBe('permission_denied');
  });

  it('is error after a failed opt-in attempt', () => {
    expect(resolvePushOptInState(READY, 'push.subscribe_failed')).toBe('error');
  });

  it('is unsupported when a required browser API is missing', () => {
    expect(resolvePushOptInState({ ...READY, pushManager: false }, null)).toBe('unsupported');
    expect(resolvePushOptInState({ ...READY, serviceWorker: false }, null)).toBe('unsupported');
    expect(resolvePushOptInState({ ...READY, notification: false }, null)).toBe('unsupported');
  });

  it('asks iOS users outside the Home Screen app to install first, even when push APIs are missing', () => {
    expect(resolvePushOptInState({ ...READY, ios: true, standalone: false }, null)).toBe('needs_install');
    expect(resolvePushOptInState({ ...READY, ios: true, standalone: false, pushManager: false }, null)).toBe('needs_install');
  });

  it('treats an iOS Home Screen app as a normal browser', () => {
    expect(resolvePushOptInState({ ...READY, ios: true, standalone: true }, null)).toBe('ready');
  });

  it('shows error for an endpoint owned by another account, even when the browser holds a subscription', () => {
    expect(resolvePushOptInState({ ...READY, subscribed: true, permission: 'granted' }, 'notification.endpoint_owned')).toBe('error');
  });

  it('shows subscribed over a stale error', () => {
    expect(resolvePushOptInState({ ...READY, subscribed: true, permission: 'granted' }, 'push.revoke_failed')).toBe('subscribed');
  });
});
