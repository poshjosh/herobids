import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { resolveNotificationPolicy } from './agent-config-helpers.js';

describe('resolveNotificationPolicy', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null for create-time empty notificationPolicy payloads', () => {
    expect(resolveNotificationPolicy({}, null)).toBeNull();
    expect(resolveNotificationPolicy({ sendMessage: {} }, null)).toBeNull();
  });

  it('preserves the current policy when a PATCH payload omits nested email fields', () => {
    const current = {
      sendMessage: {
        email: {
          enabled: true,
          source: 'explicit_update' as const,
          enabledAt: '2026-06-10T09:00:00.000Z',
        },
      },
    };

    expect(resolveNotificationPolicy({}, current)).toEqual(current);
    expect(resolveNotificationPolicy({ sendMessage: {} }, current)).toEqual(current);
  });

  it('writes enabledAt when enabling email for the first time', () => {
    expect(resolveNotificationPolicy({
      sendMessage: {
        email: { enabled: true, source: 'explicit_update' },
      },
    }, null)).toEqual({
      sendMessage: {
        email: {
          enabled: true,
          source: 'explicit_update',
          enabledAt: '2026-06-11T12:00:00.000Z',
        },
      },
    });
  });

  it('preserves enabledAt when email stays enabled', () => {
    expect(resolveNotificationPolicy({
      sendMessage: {
        email: { enabled: true, source: 'explicit_update' },
      },
    }, {
      sendMessage: {
        email: {
          enabled: true,
          source: 'explicit_prompt',
          enabledAt: '2026-06-10T09:00:00.000Z',
        },
      },
    })).toEqual({
      sendMessage: {
        email: {
          enabled: true,
          source: 'explicit_update',
          enabledAt: '2026-06-10T09:00:00.000Z',
        },
      },
    });
  });

  it('clears enabledAt when disabling email', () => {
    expect(resolveNotificationPolicy({
      sendMessage: {
        email: { enabled: false, source: 'explicit_update' },
      },
    }, {
      sendMessage: {
        email: {
          enabled: true,
          source: 'explicit_prompt',
          enabledAt: '2026-06-10T09:00:00.000Z',
        },
      },
    })).toEqual({
      sendMessage: {
        email: {
          enabled: false,
          source: 'explicit_update',
        },
      },
    });
  });
});