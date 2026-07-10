import { describe, expect, it } from 'vitest';
import {
  buildDeliveryDescriptors,
  getEmailDeliveryDescriptor,
  getMessageClassBadgeVariant,
} from './agent-message-display.js';

describe('getMessageClassBadgeVariant', () => {
  it('returns null for routine', () => {
    expect(getMessageClassBadgeVariant('routine')).toBeNull();
  });

  it('returns null for null', () => {
    expect(getMessageClassBadgeVariant(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(getMessageClassBadgeVariant(undefined)).toBeNull();
  });

  it('returns alert for alert', () => {
    expect(getMessageClassBadgeVariant('alert')).toBe('alert');
  });

  it('returns reminder for reminder', () => {
    expect(getMessageClassBadgeVariant('reminder')).toBe('reminder');
  });
});

describe('getEmailDeliveryDescriptor', () => {
  it('returns null for feed_only (email not requested)', () => {
    expect(getEmailDeliveryDescriptor('feed_only')).toBeNull();
  });

  it('returns null for null', () => {
    expect(getEmailDeliveryDescriptor(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(getEmailDeliveryDescriptor(undefined)).toBeNull();
  });

  it('returns sent descriptor for email_sent', () => {
    expect(getEmailDeliveryDescriptor('email_sent')).toEqual({
      id: 'agents.detail.emailStatus.sent',
      defaultMessage: 'Email sent',
    });
  });

  it('returns policy descriptor for email_skipped_policy', () => {
    expect(getEmailDeliveryDescriptor('email_skipped_policy')).toEqual({
      id: 'agents.detail.emailStatus.skippedPolicy',
      defaultMessage: 'Email skipped (policy)',
    });
  });

  it('returns notConfigured descriptor for email_skipped_not_configured', () => {
    expect(getEmailDeliveryDescriptor('email_skipped_not_configured')).toEqual({
      id: 'agents.detail.emailStatus.notConfigured',
      defaultMessage: 'Email not configured',
    });
  });

  it('returns noRecipient descriptor for email_skipped_no_verified_recipient', () => {
    expect(getEmailDeliveryDescriptor('email_skipped_no_verified_recipient')).toEqual({
      id: 'agents.detail.emailStatus.noRecipient',
      defaultMessage: 'No email on file',
    });
  });

  it('returns failed descriptor for email_failed_provider', () => {
    expect(getEmailDeliveryDescriptor('email_failed_provider')).toEqual({
      id: 'agents.detail.emailStatus.failed',
      defaultMessage: 'Email failed',
    });
  });
});

describe('buildDeliveryDescriptors', () => {
  it('returns both descriptor when Telegram and email both succeeded', () => {
    const result = buildDeliveryDescriptors('sent', 'email_sent');
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('agents.detail.messageDelivery.both');
  });

  it('returns telegram-only descriptor when email was not requested', () => {
    const result = buildDeliveryDescriptors('sent', 'feed_only');
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('agents.detail.messageDelivery.telegram');
  });

  it('returns telegram + email skip reason when Telegram sent but email was skipped by policy', () => {
    const result = buildDeliveryDescriptors('sent', 'email_skipped_policy');
    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe('agents.detail.messageDelivery.telegram');
    expect(result[1]?.id).toBe('agents.detail.emailStatus.skippedPolicy');
  });

  it('returns telegram + notConfigured when Telegram sent but email infra missing', () => {
    const result = buildDeliveryDescriptors('sent', 'email_skipped_not_configured');
    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe('agents.detail.messageDelivery.telegram');
    expect(result[1]?.id).toBe('agents.detail.emailStatus.notConfigured');
  });

  it('returns telegram + noRecipient when Telegram sent but no verified email', () => {
    const result = buildDeliveryDescriptors('sent', 'email_skipped_no_verified_recipient');
    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe('agents.detail.messageDelivery.telegram');
    expect(result[1]?.id).toBe('agents.detail.emailStatus.noRecipient');
  });

  it('returns telegram + emailFailed when Telegram sent but email provider failed', () => {
    const result = buildDeliveryDescriptors('sent', 'email_failed_provider');
    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe('agents.detail.messageDelivery.telegram');
    expect(result[1]?.id).toBe('agents.detail.emailStatus.failed');
  });

  it('returns email-only descriptor when only email succeeded', () => {
    const result = buildDeliveryDescriptors('pending', 'email_sent');
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('agents.detail.messageDelivery.email');
  });

  it('returns email-only descriptor when delivery failed but email succeeded', () => {
    const result = buildDeliveryDescriptors('failed', 'email_sent');
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('agents.detail.messageDelivery.email');
  });

  it('returns failedBoth when both Telegram and email failed', () => {
    const result = buildDeliveryDescriptors('failed', 'email_failed_provider');
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('agents.detail.messageDelivery.failedBoth');
  });

  it('returns telegramFailed when only Telegram failed and email not requested', () => {
    const result = buildDeliveryDescriptors('failed', 'feed_only');
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('agents.detail.messageDelivery.telegramFailed');
  });

  it('returns telegramFailed + emailSkip when Telegram failed and email was skipped', () => {
    const result = buildDeliveryDescriptors('failed', 'email_skipped_policy');
    expect(result).toHaveLength(2);
    expect(result[0]?.id).toBe('agents.detail.messageDelivery.telegramFailed');
    expect(result[1]?.id).toBe('agents.detail.emailStatus.skippedPolicy');
  });

  it('returns email skip descriptor when Telegram pending and email was skipped by policy', () => {
    const result = buildDeliveryDescriptors('pending', 'email_skipped_policy');
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('agents.detail.emailStatus.skippedPolicy');
  });

  it('returns empty array when Telegram pending and email not requested', () => {
    const result = buildDeliveryDescriptors('pending', null);
    expect(result).toHaveLength(0);
  });
});
