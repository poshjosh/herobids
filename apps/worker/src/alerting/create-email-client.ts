import { ResendEmailClient } from './resend-email-client.js';
import { SesEmailClient } from './ses-email-client.js';
import type { EmailClient } from './email-client.js';

// ---------------------------------------------------------------------------
// Provider-aware email client factory.
//
// Accepts a flat config object so the caller (index.ts) never imports a
// concrete email adapter directly. Adding a new provider only requires
// updating this factory and the config surface — no wiring changes in
// callers.
// ---------------------------------------------------------------------------

export interface EmailClientConfig {
  /** Outbound provider selector. Defaults to 'resend' during migration. */
  provider?: 'resend' | 'ses';
  /** Sender email address. */
  fromEmail?: string;
  /** Optional reply-to address. */
  replyToEmail?: string;
  /** Request timeout in ms. */
  timeoutMs?: number;
  /**
   * Resend-specific config (deprecated — will be removed in workstream 3).
   * Kept as a nested sub-object to match the `ses` pattern.
   */
  resend?: {
    apiKey?: string;
  };
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
  // SES path
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

  // Resend path — gated on explicit provider selection (not implicit fallback).
  // Will be removed entirely in workstream 3.
  if (!config.provider || config.provider === 'resend') {
    if (config.resend?.apiKey && config.fromEmail) {
      return new ResendEmailClient(config.resend.apiKey, config.fromEmail, {
        replyToEmail: config.replyToEmail,
        timeoutMs: config.timeoutMs ?? 10_000,
      });
    }
    return undefined;
  }

  return undefined;
}
