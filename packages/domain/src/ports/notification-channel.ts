import type { Result, DomainError } from '../result.js';
import type { NotificationPayload } from '../notifications/payload.js';

/** One delivery target for a user. For Web Push this is a single subscription (one device or browser). */
export interface NotificationRecipient {
  userId: string;
  subscriptionId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface NotificationSendResult {
  subscriptionId: string;
}

/** Out-of-band notification channel. Separate from the conversational ChatChannel (080). */
export interface NotificationChannel {
  notify(recipient: NotificationRecipient, payload: NotificationPayload): Promise<Result<NotificationSendResult, DomainError>>;
}
