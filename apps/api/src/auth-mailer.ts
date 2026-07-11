import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { AlertsConfig } from '@herobids/domain';

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
export function createAuthMailer(config: AlertsConfig): AuthMailer | undefined {
  const email = config.email;
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
      const command = new SendEmailCommand({
        FromEmailAddress: email.fromEmail,
        Destination: { ToAddresses: [to] },
        Content: {
          Simple: {
            Subject: { Data: 'Sign in to HeroBids' },
            Body: {
              Text: {
                Data: [
                  'Sign in to HeroBids',
                  '',
                  `Click the link below to sign in. This link expires in ${ttlSecs ? Math.round(ttlSecs / 60) : 10} minutes.`,
                  '',
                  link,
                  '',
                  'If you did not request this link, you can safely ignore this email.',
                  '',
                  '— HeroBids',
                ].join('\n'),
              },
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
