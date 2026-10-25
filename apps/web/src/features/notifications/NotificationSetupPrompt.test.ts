import { describe, expect, it } from 'vitest';
import { notificationSetupAction } from './NotificationSetupPrompt.js';
import type { MeResponse } from '../../lib/api-client.js';

const saved = (enabled: boolean) => ({ notificationPreferences: { notifications: { push: { enabled, decidedAt: '2026-10-25T00:00:00.000Z' } } } } as MeResponse);
const unanswered = { notificationPreferences: null } as MeResponse;
const base = { justCreated: true, pushEnabled: true, browserSubscribed: false, me: unanswered };

describe('notificationSetupAction', () => {
  it('offers setup right after an agent is created when the browser is not subscribed', () => {
    expect(notificationSetupAction(base)).toBe('offer');
  });

  it('offers setup again when the saved choice is on but this browser is not subscribed', () => {
    expect(notificationSetupAction({ ...base, me: saved(true) })).toBe('offer');
  });

  it('does not offer setup on a normal visit to the agent page', () => {
    expect(notificationSetupAction({ ...base, justCreated: false })).toBe('none');
  });

  it('does not offer setup when the user has switched notifications off', () => {
    expect(notificationSetupAction({ ...base, me: saved(false) })).toBe('none');
  });

  it('records an existing browser subscription when the saved choice does not say on', () => {
    expect(notificationSetupAction({ ...base, browserSubscribed: true })).toBe('record_subscribed');
    expect(notificationSetupAction({ ...base, browserSubscribed: true, me: saved(false), justCreated: false })).toBe('record_subscribed');
  });

  it('does nothing when the saved choice already matches a subscribed browser', () => {
    expect(notificationSetupAction({ ...base, browserSubscribed: true, me: saved(true) })).toBe('none');
  });

  it('does nothing when push is off on the server', () => {
    expect(notificationSetupAction({ ...base, pushEnabled: false })).toBe('none');
  });

  it('waits until the user profile has loaded', () => {
    expect(notificationSetupAction({ ...base, me: undefined })).toBe('none');
  });
});
