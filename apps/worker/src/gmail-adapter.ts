import { randomBytes } from 'node:crypto';

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

export interface EmailAttachment {
  filename: string;
  contentType: string;
  body: Buffer;
}

export interface SendEmailParams {
  to: string | string[];
  subject: string;
  body: string;
  cc?: string | string[];
  bcc?: string | string[];
  contentType?: 'text/plain' | 'text/html';
  attachments?: EmailAttachment[];
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

const MAX_ATTACHMENT_COUNT = 3;
const MAX_ATTACHMENT_TOTAL_BYTES = 5 * 1024 * 1024;
const MAX_FILENAME_BYTES = 255;
const BASE64_LINE_PATTERN = /.{1,76}/g;
const PRINTABLE_ASCII_PATTERN = /^[\x20-\x7e]*$/;
const LINE_BREAK_PATTERN = /[\r\n]/;
const MIME_TYPE_PATTERN = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;
const RFC5987_ATTR_CHAR_PATTERN = /^[A-Za-z0-9!#$&+\-.^_`|~]$/;
// 45 UTF-8 bytes -> 60 base64 chars, so each encoded-word stays within RFC 2047's 75-char limit
const SUBJECT_WORD_MAX_BYTES = 45;

function addressList(value?: string | string[]): string {
  if (!value) return '';
  return Array.isArray(value) ? value.join(', ') : value;
}

function assertNoLineBreakInAddresses(params: SendEmailParams): void {
  const lists = [params.to, params.cc, params.bcc].map(addressList);
  if (lists.some((list) => LINE_BREAK_PATTERN.test(list))) {
    throw new GmailApiError('email.invalid_recipient', 'Recipient addresses must not contain CR or LF');
  }
}

function normalizeContentType(contentType: SendEmailParams['contentType']): string {
  const value = contentType ?? 'text/plain';
  // Interpolated into a header, so CR/LF or separators must never pass
  if (!MIME_TYPE_PATTERN.test(value)) {
    throw new GmailApiError('email.invalid_attachment', 'contentType must be a type/subtype');
  }
  return value;
}

function normalizeAttachments(attachments: EmailAttachment[]): EmailAttachment[] {
  if (!Array.isArray(attachments)) {
    throw new GmailApiError('email.invalid_attachment', 'attachments must be an array');
  }
  if (attachments.length > MAX_ATTACHMENT_COUNT) {
    throw new GmailApiError('email.too_many_attachments', `At most ${MAX_ATTACHMENT_COUNT} attachments are allowed`);
  }
  const invalid = (message: string) => new GmailApiError('email.invalid_attachment', message);
  const normalized = attachments.map((attachment) => {
    if (typeof attachment !== 'object' || attachment === null) throw invalid('Each attachment must be an object');
    if (typeof attachment.filename !== 'string' || attachment.filename.trim() === '') {
      throw invalid('Attachment filename must be a non-empty string');
    }
    if (Buffer.byteLength(attachment.filename, 'utf8') > MAX_FILENAME_BYTES) {
      throw invalid(`Attachment filename must be at most ${MAX_FILENAME_BYTES} bytes`);
    }
    if (typeof attachment.contentType !== 'string') throw invalid('Attachment contentType must be a string');
    const contentType = attachment.contentType.trim() || 'application/octet-stream';
    if (!MIME_TYPE_PATTERN.test(contentType)) throw invalid('Attachment contentType must be a type/subtype');
    if (!Buffer.isBuffer(attachment.body)) throw invalid('Attachment body must be a Buffer');
    return { filename: attachment.filename, contentType, body: attachment.body };
  });
  const totalBytes = normalized.reduce((sum, attachment) => sum + attachment.body.length, 0);
  if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
    throw new GmailApiError('email.attachments_too_large', `Attachments exceed ${MAX_ATTACHMENT_TOTAL_BYTES} bytes in total`);
  }
  return normalized;
}

// Non-ASCII subjects become base64 encoded-words, so a CRLF inside them can never reach the header block
function encodeSubject(subject: string): string {
  if (PRINTABLE_ASCII_PATTERN.test(subject)) return subject;
  const words: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const char of subject) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (currentBytes + charBytes > SUBJECT_WORD_MAX_BYTES) {
      words.push(current);
      current = '';
      currentBytes = 0;
    }
    current += char;
    currentBytes += charBytes;
  }
  words.push(current);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word, 'utf8').toString('base64')}?=`).join('\r\n ');
}

function encodeRfc5987(value: string): string {
  return [...Buffer.from(value, 'utf8')]
    .map((byte) => {
      const char = String.fromCharCode(byte);
      return RFC5987_ATTR_CHAR_PATTERN.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    })
    .join('');
}

function buildAttachmentPart(attachment: EmailAttachment): string {
  const fallbackName = attachment.filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const extendedParam =
    fallbackName === attachment.filename ? '' : `; filename*=UTF-8''${encodeRfc5987(attachment.filename)}`;
  const base64Lines = attachment.body.toString('base64').match(BASE64_LINE_PATTERN)?.join('\r\n') ?? '';
  return [
    `Content-Type: ${attachment.contentType}; name="${fallbackName}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${fallbackName}"${extendedParam}`,
    '',
    base64Lines,
    '',
  ].join('\r\n');
}

function buildRawMessage(params: SendEmailParams, attachments: EmailAttachment[]): string {
  const contentType = normalizeContentType(params.contentType);
  let headers = `From: me\r\nTo: ${addressList(params.to)}\r\nSubject: ${encodeSubject(params.subject)}\r\n`;
  if (params.cc) headers += `Cc: ${addressList(params.cc)}\r\n`;
  if (params.bcc) headers += `Bcc: ${addressList(params.bcc)}\r\n`;

  if (attachments.length === 0) {
    return `${headers}Content-Type: ${contentType}; charset="UTF-8"\r\nMIME-Version: 1.0\r\n\r\n${params.body}`;
  }

  const boundary = `herobids-${randomBytes(12).toString('hex')}`;
  const textBody = params.body.replace(/\r?\n/g, '\r\n');
  const textPart =
    `--${boundary}\r\nContent-Type: ${contentType}; charset="UTF-8"\r\n` +
    `Content-Transfer-Encoding: 8bit\r\n\r\n${textBody}\r\n`;
  const attachmentParts = attachments.map((attachment) => `--${boundary}\r\n${buildAttachmentPart(attachment)}`);
  return (
    `${headers}Content-Type: multipart/mixed; boundary="${boundary}"\r\nMIME-Version: 1.0\r\n\r\n` +
    `${textPart}${attachmentParts.join('')}--${boundary}--\r\n`
  );
}

export function createGmailAdapter(deps: GmailAdapterDeps) {
  const baseUrl = 'https://gmail.googleapis.com/gmail/v1/users/me';
  const uploadUrl = 'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media';
  const headers = {
    Authorization: `Bearer ${deps.accessToken}`,
    'Content-Type': 'application/json',
  };
  const mediaHeaders = {
    Authorization: headers.Authorization,
    'Content-Type': 'message/rfc822',
  };

  return {
    async sendEmail(params: SendEmailParams): Promise<{ messageId: string; threadId: string }> {
      assertNoLineBreakInAddresses(params);
      const attachments = normalizeAttachments(params.attachments ?? []);
      const raw = buildRawMessage(params, attachments);

      // Attachments go through the media upload endpoint as raw RFC 822 bytes; the JSON path is unchanged
      const request =
        attachments.length === 0
          ? { url: `${baseUrl}/messages/send`, headers, body: JSON.stringify({ raw: Buffer.from(raw).toString('base64url') }) }
          : { url: uploadUrl, headers: mediaHeaders, body: Buffer.from(raw, 'utf8') };

      const res = await fetchWithTimeout(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
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
