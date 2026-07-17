export class GmailApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = 'GmailApiError';
  }
}

export interface GmailAdapterDeps {
  accessToken: string;
  timeoutMs?: number;
}

function fetchWithTimeout(url: string, options: RequestInit, timeoutMs?: number): Promise<Response> {
  if (!timeoutMs) return fetch(url, options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

export interface SendEmailParams {
  to: string | string[];
  subject: string;
  body: string;
  cc?: string | string[];
  bcc?: string | string[];
  contentType?: 'text/plain' | 'text/html';
}

export interface SearchEmailsParams {
  query: string;
  maxResults?: number; // default 20, max 50
}

export interface EmailSummary {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  snippet: string;
  date: string;
  labels: string[];
}

export function createGmailAdapter(deps: GmailAdapterDeps) {
  const baseUrl = 'https://gmail.googleapis.com/gmail/v1/users/me';
  const headers = {
    Authorization: `Bearer ${deps.accessToken}`,
    'Content-Type': 'application/json',
  };

  return {
    async sendEmail(params: SendEmailParams): Promise<{ messageId: string; threadId: string }> {
      const toList = Array.isArray(params.to) ? params.to.join(', ') : params.to;
      let raw = `From: me\r\nTo: ${toList}\r\nSubject: ${params.subject}\r\n`;
      if (params.cc) {
        raw += `Cc: ${Array.isArray(params.cc) ? params.cc.join(', ') : params.cc}\r\n`;
      }
      if (params.bcc) {
        raw += `Bcc: ${Array.isArray(params.bcc) ? params.bcc.join(', ') : params.bcc}\r\n`;
      }
      const contentType = params.contentType ?? 'text/plain';
      raw += `Content-Type: ${contentType}; charset="UTF-8"\r\n`;
      raw += `MIME-Version: 1.0\r\n\r\n${params.body}`;

      const rawBase64 = Buffer.from(raw).toString('base64url');

      const res = await fetchWithTimeout(`${baseUrl}/messages/send`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ raw: rawBase64 }),
      }, deps.timeoutMs);

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new GmailApiError('gmail.send_failed', `Gmail send failed: ${res.status} ${JSON.stringify(err)}`, res.status);
      }

      const data = (await res.json()) as { id: string; threadId: string };
      return { messageId: data.id, threadId: data.threadId };
    },

    async searchEmails(params: SearchEmailsParams): Promise<EmailSummary[]> {
      const maxResults = Math.min(params.maxResults ?? 20, 50);
      const q = encodeURIComponent(params.query);

      // First, list message IDs matching the query
      const listRes = await fetchWithTimeout(`${baseUrl}/messages?q=${q}&maxResults=${maxResults}`, {
        headers,
      }, deps.timeoutMs);

      if (!listRes.ok) {
        const err = await listRes.json().catch(() => ({}));
        throw new GmailApiError('gmail.search_failed', `Gmail search failed: ${listRes.status} ${JSON.stringify(err)}`, listRes.status);
      }

      const listData = (await listRes.json()) as { messages?: { id: string; threadId: string }[] };
      if (!listData.messages || listData.messages.length === 0) return [];

      // Batch-fetch message metadata
      const messages = await Promise.all(
        listData.messages.map(async (msg) => {
          const msgRes = await fetchWithTimeout(
            `${baseUrl}/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
            { headers },
            deps.timeoutMs,
          );
          if (!msgRes.ok) return null;
          const msgData = (await msgRes.json()) as {
            id: string;
            threadId: string;
            snippet: string;
            labelIds: string[];
            payload: { headers: { name: string; value: string }[] };
          };
          const hdrs = Object.fromEntries(
            (msgData.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]),
          );
          return {
            id: msgData.id,
            threadId: msgData.threadId,
            from: hdrs['from'] ?? '',
            to: hdrs['to'] ?? '',
            subject: hdrs['subject'] ?? '',
            snippet: msgData.snippet ?? '',
            date: hdrs['date'] ?? '',
            labels: msgData.labelIds ?? [],
          } satisfies EmailSummary;
        }),
      );

      return messages.filter((m): m is EmailSummary => m !== null);
    },
  };
}
