import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { AlertsConfig } from '@herobids/domain';
import { renderEmail } from '@herobids/domain';

// ---------------------------------------------------------------------------
// Auth mailer — lightweight SES wrapper for login-link email delivery.
//
// Reuses the existing operator email config surface (alerts.email.*) so
// there is a single place to configure outbound email for the whole platform.
// ---------------------------------------------------------------------------

export interface AuthMailer {
  sendLoginLink(to: string, link: string, ttlSecs?: number): Promise<{ code: string; message: string } | undefined>;
}

/**
 * Create an AuthMailer from the operator alerts config.
 * Returns undefined when email is not configured (auth emails are disabled).
 */
export function createAuthMailer(config: AlertsConfig, brandImageUrl?: string): AuthMailer | undefined {
  const email = config.email;
  const effectiveBrandImageUrl = brandImageUrl ?? email.brandImageUrl;
  if (!email.fromEmail || email.provider !== 'ses') {
    return undefined;
  }

  const client = new SESv2Client({
    region: email.ses.region,
    credentials: {
      accessKeyId: process.env['AWS_ACCESS_KEY_ID'] ?? '',
      secretAccessKey: process.env['AWS_SECRET_ACCESS_KEY'] ?? '',
    },
  });

  const timeoutMs = email.timeoutMs;

  async function sendLoginLink(to: string, link: string, ttlSecs?: number): Promise<{ code: string; message: string } | undefined> {
    try {
      const ttlMinutes = ttlSecs ? Math.round(ttlSecs / 60) : 10;
      const rendered = renderEmail({
        subject: 'Sign in to OpenAIdom',
        preheader: 'Your sign-in link is ready',
        title: 'Sign in to OpenAIdom',
        body: [
          `<p>Click the button below to sign in. This link expires in ${ttlMinutes} minutes.</p>`,
          '<p>If you did not request this link, you can safely ignore this email.</p>',
        ].join('\n'),
        cta: { text: 'Sign In', url: link },
        ...(effectiveBrandImageUrl ? { brandImageUrl: effectiveBrandImageUrl } : {}),
      });

      const command = new SendEmailCommand({
        FromEmailAddress: email.fromEmail,
        Destination: { ToAddresses: [to] },
        Content: {
          Simple: {
            Subject: { Data: rendered.subject },
            Body: {
              Text: { Data: rendered.text },
              Html: { Data: rendered.html },
            },
          },
        },
        ReplyToAddresses: email.replyToEmail ? [email.replyToEmail] : undefined,
        ConfigurationSetName: email.ses.configurationSetName,
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        await client.send(command, { abortSignal: controller.signal });
      } finally {
        clearTimeout(timer);
      }

      return undefined; // success
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const name = e instanceof Error ? e.name : '';

      if (name === 'AbortError' || name === 'TimeoutError') {
        return { code: 'auth.login_link.send_timeout', message: `Email send timed out after ${timeoutMs}ms` };
      }

      if (
        name === 'MessageRejected' ||
        name === 'MailFromDomainNotVerifiedException' ||
        message.includes('not verified') ||
        message.includes('not authorized') ||
        message.includes('Forbidden')
      ) {
        return { code: 'auth.login_link.send_misconfigured', message: 'Email provider is not fully configured' };
      }

      return { code: 'auth.login_link.send_failed', message: 'Failed to send login link email' };
    }
  }

  return { sendLoginLink };
}
