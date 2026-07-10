export type StoredNotificationPreferences = {
  sendMessage?: {
    email?: { enabled: boolean; source: 'explicit_update'; enabledAt?: string };
  };
} | null;

type NotificationPreferencesInput = {
  sendMessage?: {
    email?: { enabled: boolean };
  };
} | null;

/**
 * Resolve user-level notification preferences from an update input.
 * Writes `enabledAt` server-side when email is being enabled for the first time.
 */
export function resolveNotificationPreferences(
  input: NonNullable<NotificationPreferencesInput>,
  current: StoredNotificationPreferences,
): StoredNotificationPreferences {
  const emailInput = input.sendMessage?.email;
  if (!emailInput) {
    return current ?? null;
  }

  const currentEnabledAt = current?.sendMessage?.email?.enabledAt;
  const wasEnabled = current?.sendMessage?.email?.enabled === true;

  const enabledAt = (emailInput.enabled && !wasEnabled)
    ? new Date().toISOString()
    : (emailInput.enabled && currentEnabledAt ? currentEnabledAt : undefined);

  return {
    sendMessage: {
      email: {
        enabled: emailInput.enabled,
        source: 'explicit_update',
        ...(enabledAt ? { enabledAt } : {}),
      },
    },
  };
}
