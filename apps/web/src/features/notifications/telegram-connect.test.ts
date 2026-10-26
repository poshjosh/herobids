import { describe, expect, it } from 'vitest';
import {
  focusTargetFor,
  initialTelegramConnectState,
  parseTelegramLinkUrl,
  pollResultToAction,
  resolveConnectStatus,
  shouldCloseAbandonedTab,
  shouldPollForLink,
  shouldResetForLinked,
  telegramConnectReducer,
  telegramDisconnectBody,
  type TabHandle,
  type TelegramConnectState,
} from './telegram-connect.js';

const LINK = 'https://t.me/OpenAIdomBot?start=link_abc123';

function tabAt(href: string, closed = false): TabHandle {
  return { closed, location: { href } };
}

/** Simulates a cross-origin tab, where reading location throws. */
function crossOriginTab(): TabHandle {
  return {
    closed: false,
    location: {
      get href(): string {
        throw new DOMException('Blocked a frame from accessing a cross-origin frame.', 'SecurityError');
      },
    },
  };
}

function stateWith(overrides: Partial<TelegramConnectState>): TelegramConnectState {
  return { ...initialTelegramConnectState, ...overrides };
}

describe('telegramConnectReducer', () => {
  it('starts idle with no link, error, or blocked tab', () => {
    expect(initialTelegramConnectState).toEqual({ status: 'idle', linkUrl: null, errorMessage: null, tabBlocked: false });
  });

  it('connectStarted with an opened tab moves to connecting and clears prior link and error', () => {
    const next = telegramConnectReducer(
      stateWith({ status: 'error', linkUrl: LINK, errorMessage: 'old' }),
      { type: 'connectStarted', tabBlocked: false },
    );
    expect(next).toEqual({ status: 'connecting', linkUrl: null, errorMessage: null, tabBlocked: false });
  });

  it('connectStarted with a blocked tab records tabBlocked', () => {
    const next = telegramConnectReducer(initialTelegramConnectState, { type: 'connectStarted', tabBlocked: true });
    expect(next.status).toBe('connecting');
    expect(next.tabBlocked).toBe(true);
  });

  it('linkReceived with an opened tab stays connecting and stores the link', () => {
    const next = telegramConnectReducer(
      stateWith({ status: 'connecting' }),
      { type: 'linkReceived', url: LINK },
    );
    expect(next).toEqual({ status: 'connecting', linkUrl: LINK, errorMessage: null, tabBlocked: false });
  });

  it('linkReceived with a blocked tab moves to fallback so the user can open the link', () => {
    const next = telegramConnectReducer(
      stateWith({ status: 'connecting', tabBlocked: true }),
      { type: 'linkReceived', url: LINK },
    );
    expect(next).toEqual({ status: 'fallback', linkUrl: LINK, errorMessage: null, tabBlocked: true });
  });

  it('linkRejected moves to error with the default message and no link', () => {
    const next = telegramConnectReducer(stateWith({ status: 'connecting' }), { type: 'linkRejected' });
    expect(next).toEqual({ status: 'error', linkUrl: null, errorMessage: null, tabBlocked: false });
  });

  it('linkFailed moves to error with the given message', () => {
    const next = telegramConnectReducer(stateWith({ status: 'connecting' }), { type: 'linkFailed', message: 'Telegram connect is not configured' });
    expect(next.status).toBe('error');
    expect(next.errorMessage).toBe('Telegram connect is not configured');
    expect(next.linkUrl).toBeNull();
  });

  it('pollExpired moves to expired and drops the stale link', () => {
    const next = telegramConnectReducer(stateWith({ status: 'connecting', linkUrl: LINK }), { type: 'pollExpired' });
    expect(next).toEqual({ status: 'expired', linkUrl: null, errorMessage: null, tabBlocked: false });
  });

  it('pollFailed moves to error and keeps the message', () => {
    const next = telegramConnectReducer(stateWith({ status: 'fallback', linkUrl: LINK, tabBlocked: true }), { type: 'pollFailed', message: 'Network down' });
    expect(next).toEqual({ status: 'error', linkUrl: null, errorMessage: 'Network down', tabBlocked: true });
  });

  it('pollFailed with no message keeps errorMessage null so the view uses the default text', () => {
    const next = telegramConnectReducer(stateWith({ status: 'connecting', linkUrl: LINK }), { type: 'pollFailed', message: null });
    expect(next.status).toBe('error');
    expect(next.errorMessage).toBeNull();
  });

  it('pollLinked returns to the initial idle state', () => {
    const next = telegramConnectReducer(stateWith({ status: 'fallback', linkUrl: LINK, tabBlocked: true }), { type: 'pollLinked' });
    expect(next).toEqual(initialTelegramConnectState);
  });

  it('expired can start a new connect attempt', () => {
    const expired = telegramConnectReducer(stateWith({ status: 'connecting', linkUrl: LINK }), { type: 'pollExpired' });
    const retry = telegramConnectReducer(expired, { type: 'connectStarted', tabBlocked: false });
    expect(retry.status).toBe('connecting');
  });

  it.each([
    ['connecting', stateWith({ status: 'connecting', linkUrl: LINK })],
    ['fallback', stateWith({ status: 'fallback', linkUrl: LINK, tabBlocked: true })],
    ['expired', stateWith({ status: 'expired' })],
    ['error', stateWith({ status: 'error', linkUrl: null, errorMessage: 'Network down' })],
  ])('linkedExternally from %s resets to idle with no link, error, or blocked tab', (_name, from) => {
    expect(telegramConnectReducer(from, { type: 'linkedExternally' })).toEqual(initialTelegramConnectState);
  });

  it('after linkedExternally, an unlinked state does not poll until a new connect starts', () => {
    const reset = telegramConnectReducer(stateWith({ status: 'fallback', linkUrl: LINK, tabBlocked: true }), { type: 'linkedExternally' });
    expect(shouldPollForLink(reset, false)).toBe(false);
    const retry = telegramConnectReducer(reset, { type: 'connectStarted', tabBlocked: false });
    expect(shouldPollForLink(retry, false)).toBe(false);
    const linkReady = telegramConnectReducer(retry, { type: 'linkReceived', url: LINK });
    expect(shouldPollForLink(linkReady, false)).toBe(true);
  });
});

describe('shouldResetForLinked', () => {
  it('resets any non-idle flow once the profile is linked', () => {
    expect(shouldResetForLinked(stateWith({ status: 'connecting', linkUrl: LINK }), true)).toBe(true);
    expect(shouldResetForLinked(stateWith({ status: 'fallback', linkUrl: LINK }), true)).toBe(true);
    expect(shouldResetForLinked(stateWith({ status: 'error' }), true)).toBe(true);
  });

  it('does nothing when idle or when not linked', () => {
    expect(shouldResetForLinked(initialTelegramConnectState, true)).toBe(false);
    expect(shouldResetForLinked(stateWith({ status: 'connecting', linkUrl: LINK }), false)).toBe(false);
  });
});

describe('shouldPollForLink', () => {
  it('polls while connecting or in fallback once a link is present', () => {
    expect(shouldPollForLink(stateWith({ status: 'connecting', linkUrl: LINK }), false)).toBe(true);
    expect(shouldPollForLink(stateWith({ status: 'fallback', linkUrl: LINK, tabBlocked: true }), false)).toBe(true);
  });

  it('does not poll before a link exists', () => {
    expect(shouldPollForLink(stateWith({ status: 'connecting', linkUrl: null }), false)).toBe(false);
  });

  it('does not poll once Telegram is linked', () => {
    expect(shouldPollForLink(stateWith({ status: 'connecting', linkUrl: LINK }), true)).toBe(false);
  });

  it('does not poll in idle, expired, or error', () => {
    expect(shouldPollForLink(stateWith({ status: 'idle' }), false)).toBe(false);
    expect(shouldPollForLink(stateWith({ status: 'expired' }), false)).toBe(false);
    expect(shouldPollForLink(stateWith({ status: 'error' }), false)).toBe(false);
  });

  it('keeps polling unchanged across connecting to fallback, so the poll is not restarted', () => {
    const connecting = stateWith({ status: 'connecting', linkUrl: LINK });
    const fallback = telegramConnectReducer(connecting, { type: 'linkReceived', url: LINK });
    expect(shouldPollForLink(connecting, false)).toBe(true);
    expect(shouldPollForLink({ ...fallback, tabBlocked: true }, false)).toBe(true);
  });
});

describe('resolveConnectStatus', () => {
  it('reports connected whenever the profile has a telegram address, whatever the local state', () => {
    expect(resolveConnectStatus(stateWith({ status: 'expired' }), true)).toBe('connected');
    expect(resolveConnectStatus(initialTelegramConnectState, true)).toBe('connected');
  });

  it('reports the local status when not linked', () => {
    expect(resolveConnectStatus(stateWith({ status: 'fallback' }), false)).toBe('fallback');
  });
});

describe('pollResultToAction', () => {
  it('maps linked to pollLinked', () => {
    expect(pollResultToAction({ status: 'linked', me: { chatAddresses: [] } as never })).toEqual({ type: 'pollLinked' });
  });

  it('maps expired to pollExpired', () => {
    expect(pollResultToAction({ status: 'expired' })).toEqual({ type: 'pollExpired' });
  });

  it('maps cancelled to no action', () => {
    expect(pollResultToAction({ status: 'cancelled' })).toBeNull();
  });
});

describe('focusTargetFor', () => {
  it('moves focus to the fallback link on fallback', () => {
    expect(focusTargetFor('fallback')).toBe('fallback');
  });

  it('moves focus to the status on error', () => {
    expect(focusTargetFor('error')).toBe('status');
  });

  it('moves focus to the status on connecting, because the Connect button unmounts', () => {
    expect(focusTargetFor('connecting')).toBe('status');
  });

  it('leaves focus alone for other states', () => {
    expect(focusTargetFor('idle')).toBeNull();
    expect(focusTargetFor('connected')).toBeNull();
    expect(focusTargetFor('expired')).toBeNull();
  });
});

describe('parseTelegramLinkUrl', () => {
  it('accepts an https link on t.me', () => {
    expect(parseTelegramLinkUrl(LINK)).toBe(LINK);
  });

  it('normalises the host case and returns the canonical href', () => {
    expect(parseTelegramLinkUrl('https://T.ME/OpenAIdomBot?start=link_abc')).toBe('https://t.me/OpenAIdomBot?start=link_abc');
  });

  it('rejects plain http on t.me', () => {
    expect(parseTelegramLinkUrl('http://t.me/OpenAIdomBot?start=link_abc')).toBeNull();
  });

  it('rejects a subdomain of t.me', () => {
    expect(parseTelegramLinkUrl('https://evil.t.me/OpenAIdomBot?start=link_abc')).toBeNull();
  });

  it('rejects a host that only starts with t.me', () => {
    expect(parseTelegramLinkUrl('https://t.me.evil.com/OpenAIdomBot?start=link_abc')).toBeNull();
  });

  it('rejects a t.me URL that smuggles credentials to another host', () => {
    expect(parseTelegramLinkUrl('https://t.me@evil.com/OpenAIdomBot?start=link_abc')).toBeNull();
  });

  it('rejects userinfo on the t.me origin', () => {
    expect(parseTelegramLinkUrl('https://user:pass@t.me/OpenAIdomBot?start=link_abc')).toBeNull();
  });

  it('rejects javascript: and data: URLs', () => {
    expect(parseTelegramLinkUrl('javascript:alert(1)')).toBeNull();
    expect(parseTelegramLinkUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
  });

  it('rejects a relative or malformed value', () => {
    expect(parseTelegramLinkUrl('/OpenAIdomBot?start=link_abc')).toBeNull();
    expect(parseTelegramLinkUrl('not a url')).toBeNull();
    expect(parseTelegramLinkUrl('')).toBeNull();
  });

  it('accepts the shortest bot username (5 characters) and the longest payload (50 after link_)', () => {
    const longToken = 'a'.repeat(50);
    expect(parseTelegramLinkUrl('https://t.me/Bot_5?start=link_a')).toBe('https://t.me/Bot_5?start=link_a');
    expect(parseTelegramLinkUrl(`https://t.me/OpenAIdomBot?start=link_${longToken}`)).toBe(`https://t.me/OpenAIdomBot?start=link_${longToken}`);
  });

  it('accepts hyphen and underscore in the token payload', () => {
    expect(parseTelegramLinkUrl('https://t.me/OpenAIdomBot?start=link_a-b_c9')).toBe('https://t.me/OpenAIdomBot?start=link_a-b_c9');
  });

  it.each([
    ['a bot path shorter than 5 characters', 'https://t.me/Bot?start=link_abc'],
    ['a bot path with a hyphen', 'https://t.me/Open-Bot?start=link_abc'],
    ['an empty bot path', 'https://t.me/?start=link_abc'],
    ['a nested path', 'https://t.me/OpenAIdomBot/extra?start=link_abc'],
    ['a path with a trailing slash', 'https://t.me/OpenAIdomBot/?start=link_abc'],
    ['a path with encoded characters', 'https://t.me/Open%41IdomBot?start=link_abc'],
    ['a missing start parameter', 'https://t.me/OpenAIdomBot'],
    ['an empty start parameter', 'https://t.me/OpenAIdomBot?start='],
    ['a start without the link_ prefix', 'https://t.me/OpenAIdomBot?start=abc123'],
    ['a start with another prefix', 'https://t.me/OpenAIdomBot?start=agent_abc'],
    ['a bare link_ start with no token', 'https://t.me/OpenAIdomBot?start=link_'],
    ['a token of 51 characters', `https://t.me/OpenAIdomBot?start=link_${'a'.repeat(51)}`],
    ['a token with a dot', 'https://t.me/OpenAIdomBot?start=link_a.b'],
    ['a token with a space or slash', 'https://t.me/OpenAIdomBot?start=link_a%20b'],
    ['an extra query parameter after start', 'https://t.me/OpenAIdomBot?start=link_abc&ref=x'],
    ['an extra query parameter before start', 'https://t.me/OpenAIdomBot?ref=x&start=link_abc'],
    ['a duplicate start parameter', 'https://t.me/OpenAIdomBot?start=link_abc&start=link_def'],
    ['a fragment', 'https://t.me/OpenAIdomBot?start=link_abc#x'],
  ])('rejects %s', (_name, raw) => {
    expect(parseTelegramLinkUrl(raw)).toBeNull();
  });
});

describe('shouldCloseAbandonedTab', () => {
  it('closes a tab that was never navigated', () => {
    expect(shouldCloseAbandonedTab(tabAt('about:blank'))).toBe(true);
  });

  it('leaves a navigated tab open', () => {
    expect(shouldCloseAbandonedTab(tabAt('https://t.me/OpenAIdomBot?start=link_abc'))).toBe(false);
  });

  it('leaves a cross-origin tab alone, because reading its location throws', () => {
    expect(shouldCloseAbandonedTab(crossOriginTab())).toBe(false);
  });

  it('does not close a tab that is already closed', () => {
    expect(shouldCloseAbandonedTab(tabAt('about:blank', true))).toBe(false);
  });
});

describe('telegramDisconnectBody', () => {
  it('is exactly the user-level telegram clear payload', () => {
    expect(telegramDisconnectBody()).toStrictEqual({ chatAddresses: [{ provider: 'telegram', address: null }] });
  });
});
