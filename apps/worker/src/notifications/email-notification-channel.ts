import {
  err,
  NOTIFICATION_BODY,
  NOTIFICATION_ERROR_CODES,
  ok,
  renderEmail,
  type DomainError,
  type NotificationPayload,
  type Result,
} from '@herobids/domain';
import type { AgentRepository } from '@herobids/db';
import type { EmailClient, EmailSendResult } from '../alerting/email-client.js';

export interface EmailNotificationOptions {
  publicBaseUrl: string;
  brandImageUrl?: string;
}

type RecipientLookup = Pick<AgentRepository, 'getUserEmailByAgentId'>;

/** Longest agent name kept in the subject. Longer names are cut so a subject cannot be padded out. */
export const EMAIL_SUBJECT_AGENT_NAME_MAX_LENGTH = 80;

// Control and bidi-control characters can hide or reorder text in a mail client, so they become spaces.
const UNSAFE_SUBJECT_CHARS = /[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

export function buildEmailSubject(agentName: string): string {
  const cleaned = agentName.replace(UNSAFE_SUBJECT_CHARS, ' ').replace(/\s+/g, ' ').trim();
  const name = Array.from(cleaned).slice(0, EMAIL_SUBJECT_AGENT_NAME_MAX_LENGTH).join('');
  return `New message from ${name || 'an agent'}`;
}

/**
 * Email fallback delivery (082 E3). Sends the fixed notification text through the existing SES EmailClient.
 * It takes an agent-level payload, not a push subscription, so it does not implement NotificationChannel.
 * The subject and body never carry message text. Logs and errors never carry the recipient address.
 */
export class EmailNotificationChannel {
  constructor(
    private readonly client: EmailClient | undefined,
    private readonly recipients: RecipientLookup,
    private readonly options: EmailNotificationOptions,
  ) {}

  async notify(payload: NotificationPayload): Promise<Result<EmailSendResult, DomainError>> {
    if (!this.client) {
      return err({ code: NOTIFICATION_ERROR_CODES.emailDisabled, message: 'email_client_not_configured' });
    }

    let to: string | null;
    try {
      to = await this.recipients.getUserEmailByAgentId(payload.agentId);
    } catch (error) {
      return err({
        code: NOTIFICATION_ERROR_CODES.recipientLookupFailed,
        message: error instanceof Error ? error.name : 'NonError',
      });
    }
    if (!to) {
      return err({ code: NOTIFICATION_ERROR_CODES.recipientMissing, message: 'recipient_email_missing' });
    }

    const rendered = renderEmail({
      subject: buildEmailSubject(payload.agentName),
      title: payload.title,
      body: NOTIFICATION_BODY,
      cta: { text: 'Open conversation', url: this.absoluteUrl(payload.url) },
      ...(this.options.brandImageUrl ? { brandImageUrl: this.options.brandImageUrl } : {}),
    });

    const result = await this.client.send({
      to,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });
    if (!result.ok) {
      return err({
        code: NOTIFICATION_ERROR_CODES.providerFailed,
        message: 'provider_failed',
        context: { providerCode: result.error.code },
      });
    }
    return ok(result.data);
  }

  private absoluteUrl(path: string): string {
    return `${this.options.publicBaseUrl.replace(/\/+$/, '')}${path}`;
  }
}
