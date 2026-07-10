import { SesEmailClient } from './ses-email-client.js';
import type { EmailClient } from './email-client.js';

// ---------------------------------------------------------------------------
// Provider-aware email client factory.
//
// Accepts a config object so the caller (index.ts) never imports a
// concrete email adapter directly. Currently SES is the only supported
// provider. Adding a new provider only requires updating this factory
// and the config surface — no wiring changes in callers.
// ---------------------------------------------------------------------------

export interface EmailClientConfig {
  /** Outbound provider selector. Only 'ses' is currently supported. */
  provider?: 'ses';
  /** Sender email address. */
  fromEmail?: string;
  /** Optional reply-to address. */
  replyToEmail?: string;
  /** Request timeout in ms. */
  timeoutMs?: number;
  /** SES-specific configuration. */
  ses?: {
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    configurationSetName?: string;
  };
}

/**
 * Create an EmailClient from operator configuration.
 * Returns undefined when the provider is not configured (email is disabled).
 */
export function createEmailClient(config: EmailClientConfig): EmailClient | undefined {
  if (config.provider === 'ses') {
    const ses = config.ses;
    if (!ses?.region || !ses?.accessKeyId || !ses?.secretAccessKey || !config.fromEmail) {
      return undefined; // SES not fully configured — email disabled
    }
    return new SesEmailClient(
      config.fromEmail,
      config.replyToEmail,
      {
        region: ses.region,
        accessKeyId: ses.accessKeyId,
        secretAccessKey: ses.secretAccessKey,
        configurationSetName: ses.configurationSetName,
        timeoutMs: config.timeoutMs,
      },
    );
  }

  return undefined;
}
