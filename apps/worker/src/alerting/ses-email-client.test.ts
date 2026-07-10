import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { SesEmailClient } from './ses-email-client.js';
import type { SesEmailClientConfig } from './ses-email-client.js';

vi.mock('@aws-sdk/client-sesv2');

const sesConfig: SesEmailClientConfig = {
  region: 'us-east-1',
  accessKeyId: 'AKIATEST',
  secretAccessKey: 'test-secret',
};

describe('SesEmailClient', () => {
  let mockSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockSend = vi.fn();
    vi.mocked(SESv2Client).mockImplementation(() => ({ send: mockSend }));
    vi.mocked(SendEmailCommand).mockImplementation((params: unknown) => params);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- success ----

  it('maps a successful SES response to a normalized result', async () => {
    mockSend.mockResolvedValueOnce({ MessageId: 'ses-msg-001' });

    const client = new SesEmailClient('noreply@openaidom.com', undefined, sesConfig);
    const result = await client.send({ to: 'user@example.com', subject: 'Test', text: 'Hello' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.messageId).toBe('ses-msg-001');
    }
  });

  it('includes ReplyToAddresses when replyToEmail is configured', async () => {
    mockSend.mockResolvedValueOnce({ MessageId: 'ses-msg-002' });

    const client = new SesEmailClient('noreply@openaidom.com', 'support@openaidom.com', sesConfig);
    await client.send({ to: 'user@example.com', subject: 'Reply test', text: 'Body' });

    expect(mockSend).toHaveBeenCalledTimes(1);
    const commandArg = mockSend.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(commandArg?.ReplyToAddresses).toEqual(['support@openaidom.com']);
  });

  it('includes ConfigurationSetName when configured', async () => {
    mockSend.mockResolvedValueOnce({ MessageId: 'ses-msg-003' });

    const configWithSet: SesEmailClientConfig = { ...sesConfig, configurationSetName: 'my-config-set' };
    const client = new SesEmailClient('noreply@openaidom.com', undefined, configWithSet);
    await client.send({ to: 'user@example.com', subject: 'Config set test', text: 'Body' });

    const commandArg = mockSend.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(commandArg?.ConfigurationSetName).toBe('my-config-set');
  });

  it('omits ConfigurationSetName when not configured', async () => {
    mockSend.mockResolvedValueOnce({ MessageId: 'ses-msg-004' });

    const client = new SesEmailClient('noreply@openaidom.com', undefined, sesConfig);
    await client.send({ to: 'user@example.com', subject: 'No config set', text: 'Body' });

    const commandArg = mockSend.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(commandArg?.ConfigurationSetName).toBeUndefined();
  });

  // ---- provider error (missing MessageId) ----

  it('returns email.misconfigured when SES response has no MessageId', async () => {
    mockSend.mockResolvedValueOnce({});

    const client = new SesEmailClient('noreply@openaidom.com', undefined, sesConfig);
    const result = await client.send({ to: 'user@example.com', subject: 'Test', text: 'Hello' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('email.misconfigured');
    }
  });

  // ---- auth errors ----

  it('maps InvalidClientTokenId to email.auth_error', async () => {
    const error = new Error('The security token included in the request is invalid.');
    error.name = 'InvalidClientTokenId';
    mockSend.mockRejectedValueOnce(error);

    const client = new SesEmailClient('noreply@openaidom.com', undefined, sesConfig);
    const result = await client.send({ to: 'user@example.com', subject: 'Test', text: 'Hello' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('email.auth_error');
    }
  });

  it('maps AccessDenied to email.auth_error', async () => {
    const error = new Error('User is not authorized to perform ses:SendEmail');
    error.name = 'AccessDeniedException';
    mockSend.mockRejectedValueOnce(error);

    const client = new SesEmailClient('noreply@openaidom.com', undefined, sesConfig);
    const result = await client.send({ to: 'user@example.com', subject: 'Test', text: 'Hello' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('email.auth_error');
    }
  });

  it('maps CredentialsProviderError to email.auth_error', async () => {
    const error = new Error('Could not load credentials from any providers');
    error.name = 'CredentialsProviderError';
    mockSend.mockRejectedValueOnce(error);

    const client = new SesEmailClient('noreply@openaidom.com', undefined, sesConfig);
    const result = await client.send({ to: 'user@example.com', subject: 'Test', text: 'Hello' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('email.auth_error');
    }
  });

  it('maps UnrecognizedClientException to email.auth_error', async () => {
    const error = new Error('The security token included in the request is invalid');
    error.name = 'UnrecognizedClientException';
    mockSend.mockRejectedValueOnce(error);

    const client = new SesEmailClient('noreply@openaidom.com', undefined, sesConfig);
    const result = await client.send({ to: 'user@example.com', subject: 'Test', text: 'Hello' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('email.auth_error');
    }
  });

  // ---- misconfigured (unverified) ----

  it('maps unverified email address error to email.misconfigured', async () => {
    const error = new Error('Email address is not verified.');
    error.name = 'MessageRejected';
    mockSend.mockRejectedValueOnce(error);

    const client = new SesEmailClient('noreply@openaidom.com', undefined, sesConfig);
    const result = await client.send({ to: 'user@example.com', subject: 'Test', text: 'Hello' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('email.misconfigured');
    }
  });

  // ---- network errors ----

  it('maps ENOTFOUND to email.network_error', async () => {
    mockSend.mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND email.us-east-1.amazonaws.com'));

    const client = new SesEmailClient('noreply@openaidom.com', undefined, sesConfig);
    const result = await client.send({ to: 'user@example.com', subject: 'Test', text: 'Hello' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('email.network_error');
    }
  });

  it('maps ECONNREFUSED to email.network_error', async () => {
    mockSend.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:443'));

    const client = new SesEmailClient('noreply@openaidom.com', undefined, sesConfig);
    const result = await client.send({ to: 'user@example.com', subject: 'Test', text: 'Hello' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('email.network_error');
    }
  });

  // ---- timeout ----

  it('maps AbortError to email.timeout', async () => {
    const error = new Error('The operation was aborted.');
    error.name = 'AbortError';
    mockSend.mockRejectedValueOnce(error);

    const client = new SesEmailClient('noreply@openaidom.com', undefined, sesConfig);
    const result = await client.send({ to: 'user@example.com', subject: 'Test', text: 'Hello' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('email.timeout');
    }
  });

  // ---- generic HTTP error ----

  it('maps unrecognized errors to email.http_error', async () => {
    mockSend.mockRejectedValueOnce(new Error('Some unexpected internal error'));

    const client = new SesEmailClient('noreply@openaidom.com', undefined, sesConfig);
    const result = await client.send({ to: 'user@example.com', subject: 'Test', text: 'Hello' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('email.http_error');
    }
  });
});
