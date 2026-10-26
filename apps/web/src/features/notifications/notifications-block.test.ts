import { describe, expect, it } from 'vitest';
import { resolveNotificationsBlock, shouldRecordSubscription, type NotificationsBlockInput } from './notifications-block.js';

const base: NotificationsBlockInput = {
  variant: 'page',
  profileLoaded: true,
  telegramLinked: false,
  pushAvailable: true,
  browserSubscribed: false,
  dismissed: false,
};

describe('resolveNotificationsBlock on other pages', () => {
  it('shows Telegram and browser options when neither is set up', () => {
    expect(resolveNotificationsBlock(base)).toEqual({ show: true, showTelegram: true, showBrowser: true, showCancel: true });
  });

  it('hides the whole block when this browser is already subscribed', () => {
    expect(resolveNotificationsBlock({ ...base, browserSubscribed: true })).toEqual({ show: false, showTelegram: false, showBrowser: false, showCancel: false });
  });

  it('hides everything once Telegram is linked, even if this browser is not subscribed', () => {
    expect(resolveNotificationsBlock({ ...base, telegramLinked: true })).toEqual({ show: false, showTelegram: false, showBrowser: false, showCancel: false });
  });

  it('hides the browser option when the server has Web Push off', () => {
    expect(resolveNotificationsBlock({ ...base, pushAvailable: false })).toEqual({ show: true, showTelegram: true, showBrowser: false, showCancel: true });
  });

  it('hides until the profile has loaded', () => {
    expect(resolveNotificationsBlock({ ...base, profileLoaded: false }).show).toBe(false);
  });

  it('hides for the session once dismissed', () => {
    expect(resolveNotificationsBlock({ ...base, dismissed: true }).show).toBe(false);
  });
});

describe('resolveNotificationsBlock in settings', () => {
  it('always shows Telegram, without a cancel button', () => {
    expect(resolveNotificationsBlock({ ...base, variant: 'settings', telegramLinked: true, browserSubscribed: true })).toEqual({
      show: true, showTelegram: true, showBrowser: true, showCancel: false,
    });
  });

  it('ignores the session dismissal', () => {
    expect(resolveNotificationsBlock({ ...base, variant: 'settings', dismissed: true, profileLoaded: false }).show).toBe(true);
  });
});

describe('shouldRecordSubscription', () => {
  it('records a browser subscription the profile does not yet say is on', () => {
    expect(shouldRecordSubscription({ pushAvailable: true, browserSubscribed: true, savedPushEnabled: undefined })).toBe(true);
    expect(shouldRecordSubscription({ pushAvailable: true, browserSubscribed: true, savedPushEnabled: false })).toBe(true);
  });

  it('does nothing when the choice is already on, the browser is not subscribed, or push is off', () => {
    expect(shouldRecordSubscription({ pushAvailable: true, browserSubscribed: true, savedPushEnabled: true })).toBe(false);
    expect(shouldRecordSubscription({ pushAvailable: true, browserSubscribed: false, savedPushEnabled: undefined })).toBe(false);
    expect(shouldRecordSubscription({ pushAvailable: false, browserSubscribed: true, savedPushEnabled: undefined })).toBe(false);
  });
});
