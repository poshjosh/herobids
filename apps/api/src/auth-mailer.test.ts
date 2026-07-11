import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { createAuthMailer } from './auth-mailer.js';

// ---------------------------------------------------------------------------
// Auto-mock the AWS SDK so no real credentials or network calls are needed.
// ---------------------------------------------------------------------------
vi.mock('@aws-sdk/client-sesv2');

let mockSend: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockSend = vi.fn();
  vi.mocked(SESv2Client).mockImplementation(() => ({ send: mockSend }) as unknown as SESv2Client);
  vi.mocked(SendEmailCommand).mockClear();
  vi.mocked(SendEmailCommand).mockImplementation((params: unknown) => params as unknown as SendEmailCommand);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface EmailConfigOverrides {
  provider?: string;
  fromEmail?: string;
  replyToEmail?: string;
  timeoutMs?: number;
  ses?: { region?: string; configurationSetName?: string };
}

function makeAlertsConfig(overrides: EmailConfigOverrides = {}) {
  const defaults = {
    provider: 'ses',
    fromEmail: 'auth@herobids.ai',
    replyToEmail: '',
    timeoutMs: 10_000,
    ses: { region: 'us-east-1' },
  };
  const merged = { ...defaults, ...overrides };
  return {
    email: merged,
  } as Parameters<typeof createAuthMailer>[0];
}

// ---------------------------------------------------------------------------
// createAuthMailer
// ---------------------------------------------------------------------------

describe('createAuthMailer', () => {
  it('returns undefined when fromEmail is empty', () => {
    const mailer = createAuthMailer(makeAlertsConfig({ fromEmail: '' }));
    expect(mailer).toBeUndefined();
  });

  it('returns undefined when provider is not ses', () => {
    const mailer = createAuthMailer(makeAlertsConfig({ provider: 'smtp' }));
    expect(mailer).toBeUndefined();
  });

  it('returns an AuthMailer when config is valid', () => {
    const mailer = createAuthMailer(makeAlertsConfig());
    expect(mailer).toBeDefined();
    expect(mailer!.sendLoginLink).toBeInstanceOf(Function);
  });
});

// ---------------------------------------------------------------------------
// sendLoginLink — email body content
// ---------------------------------------------------------------------------

describe('sendLoginLink — email body rendering', () => {
  it('renders ttlSecs / 60 in the email body', async () => {
    mockSend.mockResolvedValue({ MessageId: 'msg-1' });
    const mailer = createAuthMailer(makeAlertsConfig())!;

    await mailer.sendLoginLink('user@example.com', 'https://link.example/auth?token=abc', 300);

    const params = vi.mocked(SendEmailCommand).mock.calls[0]![0] as Record<string, unknown>;
    const body = (params['Content'] as Record<string, unknown>)['Simple']['Body']['Text']['Data'];
    expect(body).toContain('This link expires in 5 minutes.');
    expect(body).toContain('https://link.example/auth?token=abc');
  });

  it('renders multiple minutes correctly (1800s → 30 min)', async () => {
    mockSend.mockResolvedValue({ MessageId: 'msg-1' });
    const mailer = createAuthMailer(makeAlertsConfig())!;

    await mailer.sendLoginLink('user@example.com', 'https://link.example/auth?token=abc', 1800);

    const params = vi.mocked(SendEmailCommand).mock.calls[0]![0] as Record<string, unknown>;
    const body = (params['Content'] as Record<string, unknown>)['Simple']['Body']['Text']['Data'];
    expect(body).toContain('This link expires in 30 minutes.');
  });

  it('falls back to 10 minutes when ttlSecs is undefined', async () => {
    mockSend.mockResolvedValue({ MessageId: 'msg-1' });
    const mailer = createAuthMailer(makeAlertsConfig())!;

    await mailer.sendLoginLink('user@example.com', 'https://link.example/auth?token=abc');

    const params = vi.mocked(SendEmailCommand).mock.calls[0]![0] as Record<string, unknown>;
    const body = (params['Content'] as Record<string, unknown>)['Simple']['Body']['Text']['Data'];
    expect(body).toContain('This link expires in 10 minutes.');
  });

  it('includes the full email structure with subject, sender, and recipient', async () => {
    mockSend.mockResolvedValue({ MessageId: 'msg-1' });
    const mailer = createAuthMailer(makeAlertsConfig({
      replyToEmail: 'support@herobids.ai',
      ses: { region: 'eu-west-1', configurationSetName: 'auth-config-set' },
    }))!;

    await mailer.sendLoginLink('recipient@example.com', 'https://example.com/link');

    const params = vi.mocked(SendEmailCommand).mock.calls[0]![0] as Record<string, unknown>;
    expect(params['FromEmailAddress']).toBe('auth@herobids.ai');
    expect(params['Destination']).toEqual({ ToAddresses: ['recipient@example.com'] });
    expect(params['ReplyToAddresses']).toEqual(['support@herobids.ai']);
    expect(params['ConfigurationSetName']).toBe('auth-config-set');
    expect((params['Content'] as Record<string, unknown>)['Simple']['Subject']['Data']).toBe('Sign in to HeroBids');
  });
});

// ---------------------------------------------------------------------------
// sendLoginLink — return values / error handling
// ---------------------------------------------------------------------------

describe('sendLoginLink — error handling', () => {
  it('returns undefined on successful send', async () => {
    mockSend.mockResolvedValue({ MessageId: 'msg-1' });
    const mailer = createAuthMailer(makeAlertsConfig())!;

    const result = await mailer.sendLoginLink('user@example.com', 'https://link.example/auth?token=abc');

    expect(result).toBeUndefined();
  });

  it('returns timeout error on AbortError', async () => {
    const abortError = new Error('Request aborted');
    abortError.name = 'AbortError';
    mockSend.mockRejectedValue(abortError);
    const mailer = createAuthMailer(makeAlertsConfig())!;

    const result = await mailer.sendLoginLink('user@example.com', 'https://link.example/auth?token=abc');

    expect(result).toEqual({
      code: 'auth.login_link.send_timeout',
      message: expect.stringContaining('timed out'),
    });
  });

  it('returns timeout error on TimeoutError', async () => {
    const timeoutError = new Error('Socket timeout');
    timeoutError.name = 'TimeoutError';
    mockSend.mockRejectedValue(timeoutError);
    const mailer = createAuthMailer(makeAlertsConfig())!;

    const result = await mailer.sendLoginLink('user@example.com', 'https://link.example/auth?token=abc');

    expect(result).toEqual({
      code: 'auth.login_link.send_timeout',
      message: expect.stringContaining('timed out'),
    });
  });

  it('returns misconfigured error on MessageRejected', async () => {
    const rejected = new Error('Address not verified');
    rejected.name = 'MessageRejected';
    mockSend.mockRejectedValue(rejected);
    const mailer = createAuthMailer(makeAlertsConfig())!;

    const result = await mailer.sendLoginLink('user@example.com', 'https://link.example/auth?token=abc');

    expect(result).toEqual({
      code: 'auth.login_link.send_misconfigured',
      message: expect.stringContaining('not fully configured'),
    });
  });

  it('returns misconfigured error on MailFromDomainNotVerifiedException', async () => {
    const domainErr = new Error('Domain not verified');
    domainErr.name = 'MailFromDomainNotVerifiedException';
    mockSend.mockRejectedValue(domainErr);
    const mailer = createAuthMailer(makeAlertsConfig())!;

    const result = await mailer.sendLoginLink('user@example.com', 'https://link.example/auth?token=abc');

    expect(result).toEqual({
      code: 'auth.login_link.send_misconfigured',
      message: expect.stringContaining('not fully configured'),
    });
  });

  it('returns misconfigured error when error message includes "not verified"', async () => {
    const err = new Error('Domain identity not verified');
    err.name = 'Error';
    mockSend.mockRejectedValue(err);
    const mailer = createAuthMailer(makeAlertsConfig())!;

    const result = await mailer.sendLoginLink('user@example.com', 'https://link.example/auth?token=abc');

    expect(result).toEqual({
      code: 'auth.login_link.send_misconfigured',
      message: expect.stringContaining('not fully configured'),
    });
  });

  it('returns misconfigured error when error message includes "forbidden"', async () => {
    const err = new Error('Access forbidden: not authorized');
    err.name = 'Error';
    mockSend.mockRejectedValue(err);
    const mailer = createAuthMailer(makeAlertsConfig())!;

    const result = await mailer.sendLoginLink('user@example.com', 'https://link.example/auth?token=abc');

    expect(result).toEqual({
      code: 'auth.login_link.send_misconfigured',
      message: expect.stringContaining('not fully configured'),
    });
  });

  it('returns generic failure for unknown errors', async () => {
    mockSend.mockRejectedValue(new Error('Network failure'));
    const mailer = createAuthMailer(makeAlertsConfig())!;

    const result = await mailer.sendLoginLink('user@example.com', 'https://link.example/auth?token=abc');

    expect(result).toEqual({
      code: 'auth.login_link.send_failed',
      message: 'Failed to send login link email',
    });
  });
});
