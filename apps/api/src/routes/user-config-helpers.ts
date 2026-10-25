export type StoredNotificationPreferences = {
  sendMessage?: {
    email?: { enabled: boolean; source: 'explicit_update'; enabledAt?: string };
  };
  notifications?: {
    emailFallback?: { enabled: boolean };
    /** The user's answer to the post-creation notification prompt; decidedAt is set once and never changes. */
    push?: { enabled: boolean; decidedAt: string };
  };
} | null;

type NotificationPreferencesInput = {
  sendMessage?: {
    email?: { enabled: boolean };
  };
  notifications?: {
    emailFallback?: { enabled: boolean };
    push?: { enabled: boolean };
  };
} | null;

/**
 * Resolve user-level notification preferences from an update input.
 * Writes `enabledAt` server-side when email is being enabled for the first time.
 * Each key is merged into the stored object, so an update to one key keeps the others.
 */
export function resolveNotificationPreferences(
  input: NonNullable<NotificationPreferencesInput>,
  current: StoredNotificationPreferences,
): StoredNotificationPreferences {
  const emailInput = input.sendMessage?.email;
  const emailFallbackInput = input.notifications?.emailFallback;
  const pushInput = input.notifications?.push;
  if (!emailInput && !emailFallbackInput && !pushInput) {
    return current ?? null;
  }

  const next: NonNullable<StoredNotificationPreferences> = { ...(current ?? {}) };

  if (emailInput) {
    const currentEnabledAt = current?.sendMessage?.email?.enabledAt;
    const wasEnabled = current?.sendMessage?.email?.enabled === true;

    const enabledAt = (emailInput.enabled && !wasEnabled)
      ? new Date().toISOString()
      : (emailInput.enabled && currentEnabledAt ? currentEnabledAt : undefined);

    next.sendMessage = {
      email: {
        enabled: emailInput.enabled,
        source: 'explicit_update',
        ...(enabledAt ? { enabledAt } : {}),
      },
    };
  }

  if (emailFallbackInput) {
    next.notifications = {
      ...current?.notifications,
      emailFallback: { ...current?.notifications?.emailFallback, enabled: emailFallbackInput.enabled },
    };
  }

  if (pushInput) {
    next.notifications = {
      ...next.notifications,
      push: {
        enabled: pushInput.enabled,
        decidedAt: current?.notifications?.push?.decidedAt ?? new Date().toISOString(),
      },
    };
  }

  return next;
}
