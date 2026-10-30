export type NotificationsBlockVariant = 'settings' | 'page';

export interface NotificationsBlockInput {
  variant: NotificationsBlockVariant;
  /** The ['me'] profile has loaded. Non-settings pages wait for it so a linked user never sees the block flash. */
  profileLoaded: boolean;
  telegramLinked: boolean;
  /** The server has Web Push on. */
  pushAvailable: boolean;
  browserSubscribed: boolean;
  /** Hidden for the rest of this browser session by the cancel button. */
  dismissed: boolean;
}

export interface NotificationsBlockView {
  show: boolean;
  showTelegram: boolean;
  showBrowser: boolean;
  showCancel: boolean;
}

/**
 * Settings always shows the block with its current state. Other pages show it only until Telegram is linked
 * or this browser is subscribed. While shown, they offer Telegram and, if this browser is not subscribed, browser notifications.
 */
export function resolveNotificationsBlock(input: NotificationsBlockInput): NotificationsBlockView {
  if (input.variant === 'settings') {
    return { show: true, showTelegram: true, showBrowser: input.pushAvailable, showCancel: false };
  }
  const show = input.profileLoaded && !input.dismissed && !input.telegramLinked && !input.browserSubscribed;
  return {
    show,
    showTelegram: show,
    showBrowser: show && input.pushAvailable,
    showCancel: show,
  };
}

/** True when this browser is subscribed but the saved profile choice does not say so yet. */
export function shouldRecordSubscription(input: { pushAvailable: boolean; browserSubscribed: boolean; savedPushEnabled: boolean | undefined }): boolean {
  return input.pushAvailable && input.browserSubscribed && input.savedPushEnabled !== true;
}

const CROSS_CHANNEL_NOTICE_KEY = 'notifications-cross-channel-notice-dismissed';

/** The cross-channel note is dismissed for good on this browser, not just for the session. */
export function readCrossChannelNoticeDismissed(): boolean {
  try {
    return window.localStorage.getItem(CROSS_CHANNEL_NOTICE_KEY) === '1';
  } catch {
    return false;
  }
}

export function rememberCrossChannelNoticeDismissed(): void {
  try {
    window.localStorage.setItem(CROSS_CHANNEL_NOTICE_KEY, '1');
  } catch {
    // Storage can be unavailable (private mode). The note then reappears on the next visit.
  }
}

const DISMISSED_KEY = 'notifications-block-dismissed';

export function readDismissedForSession(): boolean {
  try {
    return window.sessionStorage.getItem(DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function rememberDismissedForSession(): void {
  try {
    window.sessionStorage.setItem(DISMISSED_KEY, '1');
  } catch {
    // Storage can be unavailable (private mode). The block then stays hidden only until the next render.
  }
}
