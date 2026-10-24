import { beforeEach, describe, expect, it, vi } from 'vitest';
import webPush from 'web-push';
import { createWebPushSender, WEB_PUSH_REQUEST_TIMEOUT_MS, type VapidDetails, type WebPushSendRequest } from './web-push-sender.js';

vi.mock('web-push', () => {
  class WebPushError extends Error {
    constructor(readonly statusCode: number) {
      super('push failed');
    }
  }
  return { default: { sendNotification: vi.fn(), WebPushError } };
});

const vapid: VapidDetails = { subject: 'mailto:ops@example.test', publicKey: 'public', privateKey: 'private' };

const request: WebPushSendRequest = {
  endpoint: 'https://push.example.test/send/sub-1',
  p256dh: 'p256dh-key',
  auth: 'auth-key',
  payload: '{"title":"Bot"}',
  ttlSeconds: 3600,
  urgency: 'high',
};

describe('createWebPushSender', () => {
  beforeEach(() => {
    vi.mocked(webPush.sendNotification).mockReset();
  });

  it('passes a request timeout to web-push', async () => {
    vi.mocked(webPush.sendNotification).mockResolvedValue({ statusCode: 201, body: '', headers: {} });

    await createWebPushSender(vapid).send(request);

    expect(webPush.sendNotification).toHaveBeenCalledWith(
      expect.anything(),
      request.payload,
      expect.objectContaining({ timeout: WEB_PUSH_REQUEST_TIMEOUT_MS, TTL: 3600, urgency: 'high' }),
    );
    expect(WEB_PUSH_REQUEST_TIMEOUT_MS).toBe(5000);
  });
});
