import { describe, expect, it } from 'vitest';
import { resolveNotificationPreferences } from './user-config-helpers.js';

describe('resolveNotificationPreferences push choice', () => {
  it('stores the push choice with the time the user first decided', () => {
    const saved = resolveNotificationPreferences({ notifications: { push: { enabled: true } } }, null);

    expect(saved?.notifications?.push?.enabled).toBe(true);
    expect(saved?.notifications?.push?.decidedAt).toEqual(expect.any(String));
  });

  it('keeps the original decision time when the user changes the choice later', () => {
    const first = resolveNotificationPreferences({ notifications: { push: { enabled: false } } }, null);
    const later = resolveNotificationPreferences({ notifications: { push: { enabled: true } } }, first);

    expect(later?.notifications?.push).toEqual({ enabled: true, decidedAt: first?.notifications?.push?.decidedAt });
  });

  it('keeps the email settings when only the push choice is saved', () => {
    const current = { sendMessage: { email: { enabled: true, source: 'explicit_update' as const } } };
    const saved = resolveNotificationPreferences({ notifications: { push: { enabled: false } } }, current);

    expect(saved?.sendMessage).toEqual(current.sendMessage);
  });
});
