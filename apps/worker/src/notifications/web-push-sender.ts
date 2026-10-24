// Default import: web-push is CommonJS and its named exports are not visible to Node's ESM namespace import.
import webPush from 'web-push';

export interface WebPushSendRequest {
  endpoint: string;
  p256dh: string;
  auth: string;
  payload: string;
  ttlSeconds: number;
  urgency: 'very-low' | 'low' | 'normal' | 'high';
}

/** Resolves with the HTTP status from the push service. Rejects only when no response arrived. */
export interface WebPushSender {
  send(request: WebPushSendRequest): Promise<{ statusCode: number }>;
}

/** Bounds a stalled push service so one endpoint cannot hold a notification dispatch open. */
export const WEB_PUSH_REQUEST_TIMEOUT_MS = 5000;

export interface VapidDetails {
  subject: string;
  publicKey: string;
  privateKey: string;
}

/**
 * Wraps web-push. The private key is passed per request and is never logged.
 * web-push throws WebPushError for non-2xx responses; that becomes a status result, not a failure.
 */
export function createWebPushSender(vapid: VapidDetails): WebPushSender {
  return {
    async send(request) {
      try {
        const result = await webPush.sendNotification(
          { endpoint: request.endpoint, keys: { p256dh: request.p256dh, auth: request.auth } },
          request.payload,
          {
            TTL: request.ttlSeconds,
            urgency: request.urgency,
            timeout: WEB_PUSH_REQUEST_TIMEOUT_MS,
            vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
          },
        );
        return { statusCode: result.statusCode };
      } catch (error) {
        if (error instanceof webPush.WebPushError) {
          return { statusCode: error.statusCode };
        }
        throw error;
      }
    },
  };
}
