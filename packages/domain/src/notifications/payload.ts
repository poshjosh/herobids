import { err, ok, type DomainError, type Result } from '../result.js';
import type { MessagingNotificationsSchema } from '../config/schema.js';
import type { z } from 'zod';

/** Event classes that can notify a user out-of-band (081 D4). */
export const NOTIFICATION_CLASSES = ['agent.reply', 'agent.question', 'task.completed'] as const;
export type NotificationClass = (typeof NOTIFICATION_CLASSES)[number];

/** Fixed body text (081 D5). Message text never enters a notification. */
export const NOTIFICATION_BODY = 'You have a new message';

export interface NotificationPayload {
  agentId: string;
  agentName: string;
  title: string;
  body: string;
  /** App-relative link opened on tap. */
  url: string;
  eventClass: NotificationClass;
}

export interface NotificationPayloadInput {
  agentId: string;
  agentName: string;
  eventClass: NotificationClass;
}

export const NOTIFICATION_ERROR_CODES = {
  classDisabled: 'notification.class_disabled',
  subscriptionGone: 'notification.subscription_gone',
  providerFailed: 'notification.provider_failed',
  endpointOwned: 'notification.endpoint_owned',
  emailDisabled: 'notification.email_disabled',
  recipientMissing: 'notification.recipient_missing',
  recipientLookupFailed: 'notification.recipient_lookup_failed',
  dispatchFailed: 'notification.dispatch_failed',
} as const;

type NotificationsConfig = Pick<z.infer<typeof MessagingNotificationsSchema>, 'enabled' | 'eventClasses'>;

/** Pure filter: true only when the feature is on and the event class is listed. */
export function shouldNotify(eventClass: NotificationClass, config: NotificationsConfig): Result<void, DomainError> {
  if (!config.enabled) {
    return err({ code: NOTIFICATION_ERROR_CODES.classDisabled, message: 'notifications_disabled' });
  }
  if (!config.eventClasses.includes(eventClass)) {
    return err({
      code: NOTIFICATION_ERROR_CODES.classDisabled,
      message: 'event_class_not_enabled',
      context: { eventClass },
    });
  }
  return ok(undefined);
}

export function buildNotificationPayload(input: NotificationPayloadInput): NotificationPayload {
  return {
    agentId: input.agentId,
    agentName: input.agentName,
    title: input.agentName,
    body: NOTIFICATION_BODY,
    url: `/agents/${encodeURIComponent(input.agentId)}`,
    eventClass: input.eventClass,
  };
}
