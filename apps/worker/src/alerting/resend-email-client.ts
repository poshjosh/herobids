import { ok, err } from '@herobids/domain';
import type { Result } from '@herobids/domain';
import type { EmailClient, EmailMessage, EmailSendResult } from './email-client.js';

/**
 * Resend email client using direct fetch.
 * Mirrors the TelegramClient style — small, focused, no SDK dependency.
 */
export class ResendEmailClient implements EmailClient {
  private readonly baseUrl = 'https://api.resend.com';

  constructor(
    private readonly apiKey: string,
    private readonly fromEmail: string,
    private readonly opts: { replyToEmail?: string; timeoutMs: number } = { timeoutMs: 10_000 },
  ) {}

  async send(message: EmailMessage): Promise<Result<EmailSendResult, { code: string; message: string }>> {
    const body: Record<string, unknown> = {
      from: this.fromEmail,
      to: [message.to],
      subject: message.subject,
      text: message.text,
    };
    if (this.opts.replyToEmail) {
      body['reply_to'] = this.opts.replyToEmail;
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}/emails`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        const responseText = await response.text();
        return err({ code: 'resend.http_error', message: `HTTP ${response.status}: ${responseText}` });
      }

      const data = await response.json() as { id?: string };
      if (!data.id) {
        return err({ code: 'resend.missing_id', message: 'Resend response did not include a message id' });
      }

      return ok({ messageId: data.id });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (e instanceof Error && e.name === 'AbortError') {
        return err({ code: 'resend.timeout', message: `Request timed out after ${this.opts.timeoutMs}ms` });
      }
      return err({ code: 'resend.network_error', message });
    }
  }
}
