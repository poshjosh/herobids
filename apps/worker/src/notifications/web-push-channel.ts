import {
  err,
  NOTIFICATION_ERROR_CODES,
  ok,
  type DomainError,
  type NotificationChannel,
  type NotificationPayload,
  type NotificationRecipient,
  type NotificationSendResult,
  type Result,
} from '@herobids/domain';
import type { PushSubscriptionRepository } from '@herobids/db';
import { createLogger } from '../logger.js';
import type { WebPushSender } from './web-push-sender.js';

const logger = createLogger('web-push-channel');

export interface WebPushChannelOptions {
  ttlSeconds: number;
  urgency: 'very-low' | 'low' | 'normal' | 'high';
}

type SubscriptionOutcomeStore = Pick<PushSubscriptionRepository, 'markSucceeded' | 'markFailed' | 'revoke'>;

function describeTransportError(error: unknown): { name: string; code?: string } {
  if (!(error instanceof Error)) return { name: 'NonError' };
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  return code === undefined ? { name: error.name } : { name: error.name, code };
}

/**
 * Web Push delivery. Records each outcome on the subscription row.
 * 404 and 410 revoke the subscription. Any other failure (429, 5xx, transport) is recorded and never revokes.
 * Logs carry the subscription id and status only, never the endpoint.
 */
export class WebPushChannel implements NotificationChannel {
  constructor(
    private readonly sender: WebPushSender,
    private readonly subscriptions: SubscriptionOutcomeStore,
    private readonly options: WebPushChannelOptions,
  ) {}

  async notify(
    recipient: NotificationRecipient,
    payload: NotificationPayload,
  ): Promise<Result<NotificationSendResult, DomainError>> {
    let statusCode: number;
    try {
      ({ statusCode } = await this.sender.send({
        endpoint: recipient.endpoint,
        p256dh: recipient.p256dh,
        auth: recipient.auth,
        payload: JSON.stringify(payload),
        ttlSeconds: this.options.ttlSeconds,
        urgency: this.options.urgency,
      }));
    } catch (error) {
      // Name and code only: a URL error message can echo the endpoint.
      logger.warn({ subscriptionId: recipient.subscriptionId, error: describeTransportError(error) }, 'Web push transport failed');
      await this.recordFailure(recipient.subscriptionId, `${NOTIFICATION_ERROR_CODES.providerFailed}.transport_error`);
      return err({ code: NOTIFICATION_ERROR_CODES.providerFailed, message: 'transport_error' });
    }

    if (statusCode >= 200 && statusCode < 300) {
      await this.safely(() => this.subscriptions.markSucceeded(recipient.subscriptionId));
      return ok({ subscriptionId: recipient.subscriptionId });
    }

    if (statusCode === 404 || statusCode === 410) {
      logger.info({ subscriptionId: recipient.subscriptionId, statusCode }, 'Web push subscription gone; revoking');
      await this.safely(() => this.subscriptions.revoke(recipient.subscriptionId));
      return err({
        code: NOTIFICATION_ERROR_CODES.subscriptionGone,
        message: 'subscription_gone',
        context: { statusCode },
      });
    }

    logger.warn({ subscriptionId: recipient.subscriptionId, statusCode }, 'Web push provider rejected the notification');
    await this.recordFailure(recipient.subscriptionId, `${NOTIFICATION_ERROR_CODES.providerFailed}.http_${statusCode}`);
    return err({
      code: NOTIFICATION_ERROR_CODES.providerFailed,
      message: 'provider_failed',
      context: { statusCode },
    });
  }

  private async recordFailure(subscriptionId: string, code: string): Promise<void> {
    await this.safely(() => this.subscriptions.markFailed(subscriptionId, code));
  }

  /** Bookkeeping must never change the delivery outcome, so a store error is logged and swallowed. */
  private async safely(write: () => Promise<void>): Promise<void> {
    try {
      await write();
    } catch (error) {
      logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Web push outcome write failed');
    }
  }
}
