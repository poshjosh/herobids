export type PushPermission = 'default' | 'granted' | 'denied';

/** Server code for a browser endpoint already linked to another account (081 W6). */
export const ENDPOINT_OWNED_CODE = 'notification.endpoint_owned';

export type PushOptInState = 'unsupported' | 'needs_install' | 'permission_denied' | 'subscribed' | 'error' | 'ready';

/** Facts about the current browser. Detection is in detectPushEnvironment; this is the decision input. */
export interface PushEnvironment {
  serviceWorker: boolean;
  pushManager: boolean;
  notification: boolean;
  ios: boolean;
  standalone: boolean;
  permission: PushPermission;
  subscribed: boolean;
}

export interface PushEnvironmentFacts {
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
  navigatorStandalone: boolean | undefined;
  displayModeStandalone: boolean;
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  permission: string;
  subscribed: boolean;
}

/** iPadOS reports a desktop platform, so touch points distinguish it from macOS. */
export function isIosDevice(userAgent: string, platform: string, maxTouchPoints: number): boolean {
  if (/iPad|iPhone|iPod/.test(userAgent)) return true;
  return platform === 'MacIntel' && maxTouchPoints > 1;
}

export function detectPushEnvironment(facts: PushEnvironmentFacts): PushEnvironment {
  return {
    serviceWorker: facts.hasServiceWorker,
    pushManager: facts.hasPushManager,
    notification: facts.hasNotification,
    ios: isIosDevice(facts.userAgent, facts.platform, facts.maxTouchPoints),
    standalone: facts.navigatorStandalone === true || facts.displayModeStandalone,
    permission: toPermission(facts.permission),
    subscribed: facts.subscribed,
  };
}

function toPermission(value: string): PushPermission {
  if (value === 'granted' || value === 'denied') return value;
  return 'default';
}

/**
 * Order matters: on iOS outside the Home Screen app, push is never available in the tab, so the install step comes first.
 * failedCode is the last opt-in error, if any.
 */
export function resolvePushOptInState(env: PushEnvironment, failedCode: string | null): PushOptInState {
  if (env.ios && !env.standalone) return 'needs_install';
  if (!env.serviceWorker || !env.pushManager || !env.notification) return 'unsupported';
  // The server rejected this browser for this user, so the browser's own subscription does not count as on.
  if (failedCode === ENDPOINT_OWNED_CODE) return 'error';
  if (env.subscribed) return 'subscribed';
  if (env.permission === 'denied') return 'permission_denied';
  if (failedCode !== null) return 'error';
  return 'ready';
}
