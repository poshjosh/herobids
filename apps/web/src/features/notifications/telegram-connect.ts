import type { TelegramLinkPollResult } from './telegram-link-poll.js';

/** `connected` is never stored in state. It is derived from the ['me'] query so a later disconnect is reflected. */
/** `retry` is a muted, recoverable failure (the server could not be reached). `error` is red and needs action. */
export type ConnectTelegramStatus = 'idle' | 'connecting' | 'fallback' | 'connected' | 'expired' | 'error' | 'retry';

export interface TelegramConnectState {
  status: Exclude<ConnectTelegramStatus, 'connected'>;
  linkUrl: string | null;
  errorMessage: string | null;
  /** The browser blocked the pre-opened tab, so the user must open the link manually. */
  tabBlocked: boolean;
}

export type TelegramConnectAction =
  | { type: 'connectStarted'; tabBlocked: boolean }
  | { type: 'linkReceived'; url: string }
  | { type: 'linkRejected' }
  | { type: 'linkFailed'; message: string | null }
  | { type: 'pollLinked' }
  | { type: 'linkedExternally' }
  | { type: 'pollExpired' }
  | { type: 'linkRetryable' };

export const initialTelegramConnectState: TelegramConnectState = {
  status: 'idle',
  linkUrl: null,
  errorMessage: null,
  tabBlocked: false,
};

export function telegramConnectReducer(state: TelegramConnectState, action: TelegramConnectAction): TelegramConnectState {
  switch (action.type) {
    case 'connectStarted':
      return { status: 'connecting', linkUrl: null, errorMessage: null, tabBlocked: action.tabBlocked };
    case 'linkReceived':
      return {
        status: state.tabBlocked ? 'fallback' : 'connecting',
        linkUrl: action.url,
        errorMessage: null,
        tabBlocked: state.tabBlocked,
      };
    case 'linkRejected':
      return { status: 'error', linkUrl: null, errorMessage: null, tabBlocked: state.tabBlocked };
    case 'linkFailed':
      return { status: 'error', linkUrl: null, errorMessage: action.message, tabBlocked: state.tabBlocked };
    case 'linkRetryable':
      return { status: 'retry', linkUrl: null, errorMessage: null, tabBlocked: state.tabBlocked };
    case 'pollExpired':
      return { status: 'expired', linkUrl: null, errorMessage: null, tabBlocked: state.tabBlocked };
    case 'pollLinked':
    case 'linkedExternally':
      return initialTelegramConnectState;
  }
}

/** Whether polling for the link should run. Polling continues in fallback, and restarts only if the gate changes. Never runs while linked. */
export function shouldPollForLink(state: TelegramConnectState, linked: boolean): boolean {
  return !linked && (state.status === 'connecting' || state.status === 'fallback') && state.linkUrl !== null;
}

/**
 * A flow that is still open when the profile becomes linked (for example after a window focus refetch
 * while polling) is stale. It must be reset, or a later Disconnect would restart polling without a request.
 */
export function shouldResetForLinked(state: TelegramConnectState, linked: boolean): boolean {
  return linked && state.status !== 'idle';
}

export function resolveConnectStatus(state: TelegramConnectState, linked: boolean): ConnectTelegramStatus {
  return linked ? 'connected' : state.status;
}

/** A cancelled poll is ignored, because it only happens on unmount or a restarted flow. */
export function pollResultToAction(result: TelegramLinkPollResult): TelegramConnectAction | null {
  switch (result.status) {
    case 'linked':
      return { type: 'pollLinked' };
    case 'expired':
      return { type: 'pollExpired' };
    case 'cancelled':
      return null;
  }
}

/**
 * Where focus moves when the state changes. Connecting moves focus to the status because the Connect
 * button unmounts. Error moves focus to the status, and fallback moves it to the link.
 */
export function focusTargetFor(status: ConnectTelegramStatus): 'status' | 'fallback' | null {
  if (status === 'fallback') {
    return 'fallback';
  }
  if (status === 'connecting' || status === 'error' || status === 'retry') {
    return 'status';
  }
  return null;
}

const BOT_USERNAME_PATH = /^\/[A-Za-z0-9_]{5,}$/;
const START_PAYLOAD = /^link_[A-Za-z0-9_-]{1,50}$/;

/**
 * Accepts only an https URL on the t.me origin, without credentials, of the form
 * `https://t.me/<bot>?start=link_<token>`. The path must be a bot username, and the query
 * must hold exactly one `start` parameter with a valid payload. Any other parameter, a
 * fragment, or a malformed value returns null, and the caller treats it as an error.
 */
export function parseTelegramLinkUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.origin !== 'https://t.me' || url.username !== '' || url.password !== '') {
    return null;
  }
  if (!BOT_USERNAME_PATH.test(url.pathname) || url.hash !== '') {
    return null;
  }
  const params = Array.from(url.searchParams.entries());
  const [only] = params;
  if (params.length !== 1 || only === undefined || only[0] !== 'start' || !START_PAYLOAD.test(only[1])) {
    return null;
  }
  return url.href;
}

/** The subset of a browser tab the flow touches. Cross-origin tabs throw when `location` is read. */
export interface TabHandle {
  readonly closed: boolean;
  readonly location: { readonly href: string };
}

/**
 * Whether the flow may close a tab it opened. Only a tab still on about:blank was never navigated.
 * A cross-origin tab throws on access, so it is treated as not blank and left alone.
 */
export function shouldCloseAbandonedTab(tab: TabHandle): boolean {
  if (tab.closed) {
    return false;
  }
  try {
    return tab.location.href === 'about:blank';
  } catch {
    return false;
  }
}

/** Body for disconnecting the user-level Telegram chat address. */
export function telegramDisconnectBody(): { chatAddresses: Array<{ provider: 'telegram'; address: null }> } {
  return { chatAddresses: [{ provider: 'telegram', address: null }] };
}
