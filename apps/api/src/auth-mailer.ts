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
  sendLoginLink(to: string, link: string, ttlSecs?: number, locale?: string): Promise<{ code: string; message: string } | undefined>;
}

// ---------------------------------------------------------------------------
// Localized login-link email strings — keyed by BCP-47 locale code.
// ---------------------------------------------------------------------------

const LOGIN_LINK_MESSAGES: Record<string, Record<string, string>> = {
  en: {
    subject: 'Sign in to OpenAIdom',
    preheader: 'Your sign-in link is ready',
    title: 'Sign in to OpenAIdom',
    body: 'Click the button below to sign in. This link expires in {ttlMinutes} minutes.\n\nIf you did not request this link, you can safely ignore this email.',
    cta: 'Sign In',
    ctaFallback: "If the button doesn't work, copy and paste this link:",
  },
  ar: {
    subject: 'تسجيل الدخول إلى OpenAIdom',
    preheader: 'رابط تسجيل الدخول جاهز',
    title: 'تسجيل الدخول إلى OpenAIdom',
    body: 'انقر على الزر أدناه لتسجيل الدخول. تنتهي صلاحية هذا الرابط خلال {ttlMinutes} دقائق.\n\nإذا لم تطلب هذا الرابط، يمكنك تجاهل هذا البريد بأمان.',
    cta: 'تسجيل الدخول',
    ctaFallback: 'إذا لم يعمل الزر، انسخ والصق هذا الرابط:',
  },
  hi: {
    subject: 'OpenAIdom में साइन इन करें',
    preheader: 'आपका साइन-इन लिंक तैयार है',
    title: 'OpenAIdom में साइन इन करें',
    body: 'साइन इन करने के लिए नीचे दिए गए बटन पर क्लिक करें। यह लिंक {ttlMinutes} मिनट में समाप्त हो जाएगा।\n\nयदि आपने इस लिंक का अनुरोध नहीं किया है, तो आप इस ईमेल को सुरक्षित रूप से अनदेखा कर सकते हैं।',
    cta: 'साइन इन',
    ctaFallback: 'अगर बटन काम नहीं करता, तो इस लिंक को कॉपी और पेस्ट करें:',
  },
};

function getLoginLinkMessages(locale: string): Record<string, string> {
  return LOGIN_LINK_MESSAGES[locale] ?? LOGIN_LINK_MESSAGES['en']!;
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

  async function sendLoginLink(to: string, link: string, ttlSecs?: number, locale?: string): Promise<{ code: string; message: string } | undefined> {
    try {
      const ttlMinutes = ttlSecs ? Math.round(ttlSecs / 60) : 10;
      const effectiveLocale = locale ?? 'en';
      const messages = getLoginLinkMessages(effectiveLocale);
      const bodyText = messages['body']!.replace('{ttlMinutes}', String(ttlMinutes));
      const bodyHtml = bodyText.split('\n\n').map(p => `<p>${p}</p>`).join('\n');
      const rendered = renderEmail({
        subject: messages['subject']!,
        preheader: messages['preheader']!,
        title: messages['title']!,
        body: bodyHtml,
        cta: { text: messages['cta']!, url: link },
        ctaFallbackText: messages['ctaFallback'],
        locale: effectiveLocale,
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
