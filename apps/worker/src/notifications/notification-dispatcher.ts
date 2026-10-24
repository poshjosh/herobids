import {
  buildNotificationPayload,
  decideFallback,
  err,
  isEmailFallbackAllowed,
  NOTIFICATION_ERROR_CODES,
  ok,
  shouldNotify,
  type AppConfig,
  type DomainError,
  type NotificationChannel,
  type NotificationClass,
  type NotificationPayload,
  type Result,
} from '@herobids/domain';
import type { AgentRepository, NotificationDeliveryRepository, PushSubscriptionRepository } from '@herobids/db';
import { createLogger } from '../logger.js';
import type { EmailNotificationChannel } from './email-notification-channel.js';

const logger = createLogger('notification-dispatcher');

const EMAIL_CAP_WINDOW_MS = 24 * 60 * 60 * 1000;

function emailWindowStart(): Date {
  return new Date(Date.now() - EMAIL_CAP_WINDOW_MS);
}

export interface NotificationDispatchEvent {
  userId: string;
  agentId: string;
  agentName: string;
  /** Unique per outbound message. Keys the delivery ledger so one event never sends two emails. */
  eventKey: string;
  eventClass: NotificationClass;
}

export interface NotificationDispatchOutcome {
  route: 'none' | 'email';
  reason: string;
  /** True only when the provider accepted the fallback email. */
  emailDelivered: boolean;
}

export interface NotificationDispatcherDeps {
  config: AppConfig['messaging']['notifications'];
  /** Absent when Web Push is off or its VAPID settings are incomplete. */
  webPush?: {
    channel: NotificationChannel;
    subscriptions: Pick<PushSubscriptionRepository, 'listActiveForUser'>;
  };
  /** Absent when no email client is configured. */
  email?: Pick<EmailNotificationChannel, 'notify'>;
  deliveries: Pick<NotificationDeliveryRepository, 'reserveEmailIfUnderCap' | 'countEmailSince' | 'updateStatus'>;
  preferences: Pick<AgentRepository, 'getUserNotificationPreferences'>;
}

interface PushSummary {
  subscriptionCount: number;
  succeeded: boolean;
}

function none(reason: string): NotificationDispatchOutcome {
  return { route: 'none', reason, emailDelivered: false };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.name : 'NonError';
}

/**
 * Chooses one route per agent message (082 E5): push to each active subscription, then email only when
 * decideFallback says push could not reach the user. Never throws. Logs carry ids and codes, never addresses or text.
 */
export class NotificationDispatcher {
  constructor(private readonly deps: NotificationDispatcherDeps) {}

  async dispatch(event: NotificationDispatchEvent): Promise<Result<NotificationDispatchOutcome, DomainError>> {
    const gate = shouldNotify(event.eventClass, this.deps.config);
    if (!gate.ok) return ok(none(gate.error.code));

    const payload = buildNotificationPayload({
      agentId: event.agentId,
      agentName: event.agentName,
      eventClass: event.eventClass,
    });
    try {
      const push = await this.pushToSubscriptions(event, payload);
      const decision = await this.decide(event, push);
      if (decision.route === 'none') return ok(none(decision.reason));
      return ok(await this.sendEmail(event, payload, decision.reason));
    } catch (error) {
      logger.error(
        { agentId: event.agentId, eventClass: event.eventClass, error: describeError(error) },
        'Agent notification dispatch failed',
      );
      return err({ code: NOTIFICATION_ERROR_CODES.dispatchFailed, message: 'dispatch_failed' });
    }
  }

  private async pushToSubscriptions(event: NotificationDispatchEvent, payload: NotificationPayload): Promise<PushSummary> {
    const webPush = this.deps.webPush;
    if (!webPush) return { subscriptionCount: 0, succeeded: false };

    const subscriptions = await webPush.subscriptions.listActiveForUser(event.userId);
    let succeeded = false;
    for (const subscription of subscriptions) {
      try {
        const result = await webPush.channel.notify(
          {
            userId: subscription.userId,
            subscriptionId: subscription.id,
            endpoint: subscription.endpoint,
            p256dh: subscription.p256dh,
            auth: subscription.auth,
          },
          payload,
        );
        if (result.ok) {
          succeeded = true;
        } else {
          logger.warn({ agentId: event.agentId, subscriptionId: subscription.id, code: result.error.code }, 'Agent push not delivered');
        }
      } catch (error) {
        logger.warn(
          { agentId: event.agentId, subscriptionId: subscription.id, error: describeError(error) },
          'Agent push dispatch threw',
        );
      }
    }
    return { subscriptionCount: subscriptions.length, succeeded };
  }

  private async decide(event: NotificationDispatchEvent, push: PushSummary): Promise<{ route: 'none' | 'email'; reason: string }> {
    const emailConfig = this.deps.config.email;
    const emailListed = emailConfig.enabled && emailConfig.eventClasses.includes(event.eventClass);
    // Checked before any read: with no client, email cannot be the route, so no preference or count is loaded.
    if (emailListed && !this.deps.email && !push.succeeded) {
      return { route: 'none', reason: NOTIFICATION_ERROR_CODES.emailDisabled };
    }
    // Read only when email could be the route, so a push-only deployment adds no database reads per message.
    const emailState = emailListed && !push.succeeded ? await this.readEmailState(event.userId) : null;

    return decideFallback({
      hasActiveSubscriptions: push.subscriptionCount > 0,
      pushAttempted: push.subscriptionCount > 0,
      pushSucceeded: push.succeeded,
      emailClassEnabled: emailListed,
      // Unused when emailState is null: decideFallback returns before these fields are checked.
      userOptedOut: emailState?.optedOut ?? false,
      dailyEmailCount: emailState?.dailyEmailCount ?? 0,
      maxPerUserPerDay: emailConfig.maxPerUserPerDay,
    });
  }

  private async readEmailState(userId: string): Promise<{ optedOut: boolean; dailyEmailCount: number }> {
    const storedPreferences = await this.deps.preferences.getUserNotificationPreferences(userId);
    const dailyEmailCount = await this.deps.deliveries.countEmailSince(userId, emailWindowStart());
    return {
      optedOut: !isEmailFallbackAllowed(storedPreferences, this.deps.config.email.userDefaultEnabled),
      dailyEmailCount,
    };
  }

  private async sendEmail(
    event: NotificationDispatchEvent,
    payload: NotificationPayload,
    reason: string,
  ): Promise<NotificationDispatchOutcome> {
    const email = this.deps.email;
    if (!email) {
      logger.warn({ agentId: event.agentId }, 'Email fallback chosen but no email client is configured');
      return none(NOTIFICATION_ERROR_CODES.emailDisabled);
    }

    // Reserved before the send. The cap check and the insert are one atomic step, so concurrent decisions
    // for one user cannot both take the last slot. The unique key blocks a second send on retry or from another replica.
    const reservation = await this.deps.deliveries.reserveEmailIfUnderCap({
      userId: event.userId,
      agentId: event.agentId,
      eventKey: event.eventKey,
      channel: 'email',
      reason,
      since: emailWindowStart(),
      maxPerUserPerDay: this.deps.config.email.maxPerUserPerDay,
    });
    if (reservation.outcome === 'duplicate') return none('notification.duplicate_event');
    if (reservation.outcome === 'rate_limited') return none('notification.rate_limited');

    const rowId = reservation.id;
    const result = await email.notify(payload);
    if (result.ok) {
      await this.deps.deliveries.updateStatus(rowId, 'sent', reason);
      logger.info({ agentId: event.agentId, eventClass: event.eventClass, reason }, 'Agent notification sent by email fallback');
      return { route: 'email', reason, emailDelivered: true };
    }

    await this.deps.deliveries.updateStatus(rowId, 'failed', result.error.code);
    logger.warn({ agentId: event.agentId, eventClass: event.eventClass, code: result.error.code }, 'Email fallback not delivered');
    return { route: 'email', reason, emailDelivered: false };
  }
}
