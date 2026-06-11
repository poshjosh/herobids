import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ResendEmailClient } from './resend-email-client.js';

describe('ResendEmailClient', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(global, 'fetch');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps a successful Resend response to a normalized result', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'msg_abc123' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = new ResendEmailClient('re_key', 'from@example.com', { timeoutMs: 5000 });
    const result = await client.send({ to: 'user@example.com', subject: 'Test', text: 'Hello' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.messageId).toBe('msg_abc123');
    }
  });

  it('maps an HTTP error response to a stable error code', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('Unauthorized', { status: 401 }),
    );

    const client = new ResendEmailClient('bad_key', 'from@example.com', { timeoutMs: 5000 });
    const result = await client.send({ to: 'user@example.com', subject: 'Test', text: 'Hello' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('resend.http_error');
    }
  });

  it('maps a network failure to resend.network_error', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('connection refused'));

    const client = new ResendEmailClient('re_key', 'from@example.com', { timeoutMs: 5000 });
    const result = await client.send({ to: 'user@example.com', subject: 'Test', text: 'Hello' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('resend.network_error');
    }
  });

  it('includes reply_to in the request body when configured', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'msg_xyz' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = new ResendEmailClient('re_key', 'from@example.com', {
      replyToEmail: 'reply@example.com',
      timeoutMs: 5000,
    });
    await client.send({ to: 'user@example.com', subject: 'Test', text: 'Hello' });

    const callArgs = fetchSpy.mock.calls[0];
    const body = JSON.parse(callArgs![1]!.body as string) as { reply_to?: string };
    expect(body.reply_to).toBe('reply@example.com');
  });
});
