/**
 * Pure display helpers for agent outbound message rendering.
 * Functions return i18n descriptors (id + defaultMessage) rather than
 * formatted strings so they remain testable without an IntlProvider.
 */

export interface MessageDeliveryDescriptor {
  id: string;
  defaultMessage: string;
}

/**
 * Returns the badge variant for a given messageClass value.
 * `routine` (or null) returns null — no badge rendered.
 */
export function getMessageClassBadgeVariant(
  messageClass: string | null | undefined,
): 'alert' | 'reminder' | null {
  if (messageClass === 'alert') return 'alert';
  if (messageClass === 'reminder') return 'reminder';
  return null;
}

/**
 * Returns an i18n descriptor for the email-specific delivery outcome,
 * or null when email was not attempted (feed_only / null).
 */
export function getEmailDeliveryDescriptor(
  emailDeliveryStatus: string | null | undefined,
): MessageDeliveryDescriptor | null {
  switch (emailDeliveryStatus) {
    case 'email_sent':
      return { id: 'agents.detail.emailStatus.sent', defaultMessage: 'Email sent' };
    case 'email_skipped_policy':
      return { id: 'agents.detail.emailStatus.skippedPolicy', defaultMessage: 'Email skipped (policy)' };
    case 'email_skipped_not_configured':
      return { id: 'agents.detail.emailStatus.notConfigured', defaultMessage: 'Email not configured' };
    case 'email_skipped_no_verified_recipient':
      return { id: 'agents.detail.emailStatus.noRecipient', defaultMessage: 'No email on file' };
    case 'email_failed_provider':
      return { id: 'agents.detail.emailStatus.failed', defaultMessage: 'Email failed' };
    default:
      // feed_only, null, undefined → email delivery was not requested
      return null;
  }
}

/**
 * Builds the ordered list of delivery descriptors for a given message's
 * delivery state. The caller joins them (e.g. with ' · ') or renders
 * them separately.
 *
 * Rules:
 * - If Telegram AND email both succeeded → single "both" descriptor.
 * - If Telegram succeeded, append email detail when email was attempted.
   * - If only email succeeded (Telegram not sent or failed) → email descriptor.
 * - If both failed → "failedBoth" descriptor.
 * - If only Telegram failed, append email detail for non-fail/non-null states.
 * - Otherwise fall through to email-only descriptor.
 */
export function buildDeliveryDescriptors(
  deliveryStatus: string,
  emailDeliveryStatus: string | null | undefined,
): MessageDeliveryDescriptor[] {
  const viaTelegram = deliveryStatus === 'sent';
  const viaEmail = emailDeliveryStatus === 'email_sent';
  const emailDesc = getEmailDeliveryDescriptor(emailDeliveryStatus);

  if (viaTelegram && viaEmail) {
    return [{ id: 'agents.detail.messageDelivery.both', defaultMessage: 'Delivered via Telegram and email' }];
  }

  if (viaTelegram) {
    const base: MessageDeliveryDescriptor = {
      id: 'agents.detail.messageDelivery.telegram',
      defaultMessage: 'Delivered via Telegram',
    };
    // Append email outcome when email was attempted but not successfully sent
    if (emailDesc !== null && emailDeliveryStatus !== 'email_sent') {
      return [base, emailDesc];
    }
    return [base];
  }

  if (viaEmail) {
    return [{ id: 'agents.detail.messageDelivery.email', defaultMessage: 'Delivered via email' }];
  }

  if (deliveryStatus === 'failed' && emailDeliveryStatus === 'email_failed_provider') {
    return [{ id: 'agents.detail.messageDelivery.failedBoth', defaultMessage: 'Telegram and email delivery failed' }];
  }

  if (deliveryStatus === 'failed') {
    const base: MessageDeliveryDescriptor = {
      id: 'agents.detail.messageDelivery.telegramFailed',
      defaultMessage: 'Telegram delivery failed',
    };
    // Append email skip detail when email was attempted but skipped (not a hard fail)
    if (
      emailDesc !== null &&
      emailDeliveryStatus !== 'email_sent' &&
      emailDeliveryStatus !== 'email_failed_provider'
    ) {
      return [base, emailDesc];
    }
    return [base];
  }

  // Telegram not sent yet (pending) — show email-only status if email was attempted
  if (emailDesc !== null) {
    return [emailDesc];
  }

  return [];
}
