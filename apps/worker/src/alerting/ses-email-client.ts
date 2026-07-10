import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { ok, err } from '@herobids/domain';
import type { Result } from '@herobids/domain';
import type { EmailClient, EmailMessage, EmailSendResult } from './email-client.js';

// ---------------------------------------------------------------------------
// SES email client — adapter implementing the provider-neutral EmailClient port.
//
// Normalizes AWS SDK errors into stable app error codes so callers never
// depend on provider-specific exception shapes.
// ---------------------------------------------------------------------------

export interface SesEmailClientConfig {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  configurationSetName?: string;
  timeoutMs?: number;
}

export class SesEmailClient implements EmailClient {
  private readonly client: SESv2Client;
  private readonly timeoutMs: number;

  constructor(
    private readonly fromEmail: string,
    private readonly replyToEmail: string | undefined,
    private readonly sesConfig: SesEmailClientConfig,
  ) {
    this.client = new SESv2Client({
      region: sesConfig.region,
      credentials: {
        accessKeyId: sesConfig.accessKeyId,
        secretAccessKey: sesConfig.secretAccessKey,
      },
    });
    this.timeoutMs = sesConfig.timeoutMs ?? 10_000;
  }

  async send(message: EmailMessage): Promise<Result<EmailSendResult, { code: string; message: string }>> {
    try {
      const command = new SendEmailCommand({
        FromEmailAddress: this.fromEmail,
        Destination: {
          ToAddresses: [message.to],
        },
        Content: {
          Simple: {
            Subject: { Data: message.subject },
            Body: { Text: { Data: message.text } },
          },
        },
        ReplyToAddresses: this.replyToEmail ? [this.replyToEmail] : undefined,
        ConfigurationSetName: this.sesConfig.configurationSetName,
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      let response: { MessageId?: string };
      try {
        response = await this.client.send(command, { abortSignal: controller.signal });
      } finally {
        clearTimeout(timer);
      }

      if (!response.MessageId) {
        return err({ code: 'email.misconfigured', message: 'SES response did not include a MessageId' });
      }

      return ok({ messageId: response.MessageId });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const name = e instanceof Error ? e.name : '';

      // Normalize AWS SDK errors into stable app error codes.
      // Checks are ordered from most-specific to least-specific so that
      // generic patterns (e.g. name.includes('Error')) don't shadow
      // narrower classifications.

      // Timeout / abort
      if (name === 'AbortError' || name === 'TimeoutError') {
        return err({ code: 'email.timeout', message: `SES request timed out after ${this.timeoutMs}ms` });
      }

      // Auth / credentials errors (check name for AWS SDK error codes)
      if (
        name === 'CredentialsProviderError' ||
        name === 'InvalidClientTokenId' ||
        name === 'AccessDeniedException' ||
        name === 'AccessDenied' ||
        name === 'UnrecognizedClientException' ||
        message.includes('credentials') ||
        message.includes('not authorized') ||
        message.includes('Forbidden')
      ) {
        return err({ code: 'email.auth_error', message });
      }

      // Misconfigured — unverified domain or email address
      if (
        name === 'MessageRejected' ||
        name === 'MailFromDomainNotVerifiedException' ||
        message.includes('Email address is not verified') ||
        message.includes('MailFromDomainNotVerified') ||
        message.includes('not verified')
      ) {
        return err({ code: 'email.misconfigured', message });
      }

      // Network-level failures (DNS, connection refused, etc.)
      if (message.includes('ENOTFOUND') || message.includes('ECONNREFUSED') || message.includes('ETIMEDOUT') || message.includes('getaddrinfo')) {
        return err({ code: 'email.network_error', message });
      }

      // Catch-all for unexpected errors
      return err({ code: 'email.http_error', message });
    }
  }
}
