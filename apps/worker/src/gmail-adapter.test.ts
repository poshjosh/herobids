import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGmailAdapter, type EmailAttachment, type SendEmailParams } from './gmail-adapter.js';

const MIB = 1024 * 1024;
const JSON_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';
const UPLOAD_SEND_URL = 'https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media';

function stubFetch() {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ id: 'msg-1', threadId: 'thread-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function sentRequest(fetchMock: ReturnType<typeof stubFetch>): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return { url, init };
}

// JSON path: the body is { raw } where raw is base64url of the RFC 822 message
function sentJsonRaw(fetchMock: ReturnType<typeof stubFetch>): string {
  const { init } = sentRequest(fetchMock);
  const { raw } = JSON.parse(String(init.body)) as { raw: string };
  return Buffer.from(raw, 'base64url').toString('utf8');
}

// Upload path: the body is the raw RFC 822 bytes themselves
function sentMime(fetchMock: ReturnType<typeof stubFetch>): Buffer {
  const { init } = sentRequest(fetchMock);
  expect(Buffer.isBuffer(init.body)).toBe(true);
  return init.body as Buffer;
}

function sendEmail(overrides: Partial<SendEmailParams> = {}) {
  return createGmailAdapter({ accessToken: 'token' }).sendEmail({
    to: 'alice@example.com',
    subject: 'Hello',
    body: 'Hi there',
    ...overrides,
  });
}

function attachment(size: number, filename = 'file.bin'): EmailAttachment {
  return { filename, contentType: 'application/octet-stream', body: Buffer.alloc(size, 7) };
}

// Decodes every attachment part of a multipart/mixed message; the base64 layer is checked strictly
function decodeAttachments(mime: Buffer): Buffer[] {
  const raw = mime.toString('utf8');
  const boundary = /boundary="([^"]+)"/.exec(raw)?.[1];
  if (!boundary) throw new Error('multipart boundary not found');
  return raw
    .split(`--${boundary}`)
    .filter((part) => part.includes('Content-Disposition: attachment'))
    .map((part) => {
      expect(part).toContain('Content-Transfer-Encoding: base64\r\n');
      const content = part.slice(part.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, '');
      expect(content).toMatch(/^[A-Za-z0-9+/=\r\n]*$/);
      const lines = content.split('\r\n');
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(76);
      const base64 = lines.join('');
      expect(base64.length % 4).toBe(0);
      return Buffer.from(base64, 'base64');
    });
}

describe('createGmailAdapter.sendEmail', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps a message without attachments on the JSON endpoint, byte-for-byte unchanged', async () => {
    const fetchMock = stubFetch();

    await sendEmail({ cc: ['bob@example.com'], bcc: 'carol@example.com' });

    const { url, init } = sentRequest(fetchMock);
    expect(url).toBe(JSON_SEND_URL);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: 'Bearer token', 'Content-Type': 'application/json' });
    expect(JSON.parse(String(init.body))).toEqual({
      raw: Buffer.from(
        'From: me\r\nTo: alice@example.com\r\nSubject: Hello\r\nCc: bob@example.com\r\nBcc: carol@example.com\r\n' +
          'Content-Type: text/plain; charset="UTF-8"\r\nMIME-Version: 1.0\r\n\r\nHi there',
      ).toString('base64url'),
    });
    expect(sentJsonRaw(fetchMock)).toBe(
      'From: me\r\nTo: alice@example.com\r\nSubject: Hello\r\nCc: bob@example.com\r\nBcc: carol@example.com\r\n' +
        'Content-Type: text/plain; charset="UTF-8"\r\nMIME-Version: 1.0\r\n\r\nHi there',
    );
  });

  it('sends attachments to the media upload endpoint as raw message/rfc822 bytes', async () => {
    const fetchMock = stubFetch();
    const bytes = Buffer.from(Array.from({ length: 300 }, (_, i) => i % 256));

    await sendEmail({
      attachments: [{ filename: 'data.bin', contentType: 'application/octet-stream', body: bytes }],
    });

    const { url, init } = sentRequest(fetchMock);
    expect(url).toBe(UPLOAD_SEND_URL);
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ Authorization: 'Bearer token', 'Content-Type': 'message/rfc822' });

    const mime = sentMime(fetchMock);
    const raw = mime.toString('utf8');
    expect(raw.startsWith('From: me\r\nTo: alice@example.com\r\nSubject: Hello\r\n')).toBe(true);
    expect(raw).toMatch(/Content-Type: multipart\/mixed; boundary="herobids-[0-9a-f]+"/);
    expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: 8bit\r\n\r\nHi there');
    expect(raw).toContain('Content-Disposition: attachment; filename="data.bin"\r\n');
    expect(raw).not.toContain('filename*=');
    expect(decodeAttachments(mime).map((decoded) => decoded.equals(bytes))).toEqual([true]);
  });

  it('encodes a non-ASCII filename with RFC 2231 and a safe ASCII fallback', async () => {
    const fetchMock = stubFetch();

    await sendEmail({ attachments: [attachment(4, 'résumé "final".pdf')] });

    expect(sentMime(fetchMock).toString('utf8')).toContain(
      `Content-Disposition: attachment; filename="r_sum_ _final_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22.pdf`,
    );
  });

  it('sanitises a filename containing CRLF so it cannot inject a Bcc header', async () => {
    const fetchMock = stubFetch();

    await sendEmail({ attachments: [attachment(4, 'a\r\nBcc: x@example.com.pdf')] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const raw = sentMime(fetchMock).toString('utf8');
    expect(raw.split('\r\n').some((line) => line.startsWith('Bcc:'))).toBe(false);
    expect(raw).not.toMatch(/\r?\nBcc:/);
    expect(raw).toContain(
      `Content-Disposition: attachment; filename="a__Bcc: x@example.com.pdf"; filename*=UTF-8''a%0D%0ABcc%3A%20x%40example.com.pdf`,
    );
  });

  it('encodes a subject containing CRLF so it cannot inject a Bcc header', async () => {
    const fetchMock = stubFetch();

    await sendEmail({ subject: 'Hello\r\nBcc: attacker@example.com' });

    const raw = sentJsonRaw(fetchMock);
    expect(raw.split('\r\n').some((line) => line.startsWith('Bcc:'))).toBe(false);
    const subjectLine = raw.split('\r\n').find((line) => line.startsWith('Subject: '));
    const encodedWord = /^Subject: =\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=$/.exec(subjectLine ?? '')?.[1];
    expect(Buffer.from(encodedWord ?? '', 'base64').toString('utf8')).toBe('Hello\r\nBcc: attacker@example.com');
  });

  it.each([
    { to: 'alice@example.com\r\nBcc: attacker@example.com' },
    { cc: 'bob@example.com\nBcc: attacker@example.com' },
    { bcc: ['carol@example.com\r'] },
  ])('rejects a recipient containing CR or LF before any fetch: %o', async (overrides) => {
    const fetchMock = stubFetch();

    await expect(sendEmail(overrides)).rejects.toMatchObject({ code: 'email.invalid_recipient' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects more than 3 attachments before any fetch', async () => {
    const fetchMock = stubFetch();

    await expect(sendEmail({ attachments: [attachment(1), attachment(1), attachment(1), attachment(1)] })).rejects.toMatchObject({
      code: 'email.too_many_attachments',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects attachments totalling more than 5 MiB before any fetch', async () => {
    const fetchMock = stubFetch();

    await expect(sendEmail({ attachments: [attachment(3 * MIB), attachment(2 * MIB + 1)] })).rejects.toMatchObject({
      code: 'email.attachments_too_large',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts exactly 3 attachments totalling exactly 5 MiB and delivers each byte-for-byte', async () => {
    const fetchMock = stubFetch();
    const inputs = [randomBytes(1 * MIB), randomBytes(2 * MIB), randomBytes(2 * MIB)];

    const result = await sendEmail({
      attachments: inputs.map((body, i) => ({ filename: `part-${i}.bin`, contentType: 'application/octet-stream', body })),
    });

    expect(result).toEqual({ messageId: 'msg-1', threadId: 'thread-1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const decoded = decodeAttachments(sentMime(fetchMock));
    expect(decoded).toHaveLength(3);
    inputs.forEach((input, i) => expect(decoded[i]?.equals(input)).toBe(true));
  });

  it('rejects an attachment whose body is not a Buffer before any fetch', async () => {
    const fetchMock = stubFetch();

    await expect(
      sendEmail({ attachments: [{ filename: 'note.txt', contentType: 'text/plain', body: 'not bytes' as unknown as Buffer }] }),
    ).rejects.toMatchObject({ code: 'email.invalid_attachment' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'a null element', attachments: [null] },
    { label: 'a number element', attachments: [42] },
    { label: 'a non-array value', attachments: 'attachment' },
  ])('rejects $label with email.invalid_attachment before any fetch', async ({ attachments }) => {
    const fetchMock = stubFetch();

    await expect(sendEmail({ attachments: attachments as unknown as EmailAttachment[] })).rejects.toMatchObject({
      code: 'email.invalid_attachment',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a filename over 255 UTF-8 bytes and accepts exactly 255', async () => {
    const fetchMock = stubFetch();

    await expect(sendEmail({ attachments: [attachment(1, 'a'.repeat(256))] })).rejects.toMatchObject({
      code: 'email.invalid_attachment',
    });
    // 128 characters but 256 bytes in UTF-8
    await expect(sendEmail({ attachments: [attachment(1, 'é'.repeat(128))] })).rejects.toMatchObject({
      code: 'email.invalid_attachment',
    });
    expect(fetchMock).not.toHaveBeenCalled();

    await sendEmail({ attachments: [attachment(1, 'a'.repeat(255))] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([{ attachments: undefined }, { attachments: [attachment(1)] }])(
    'rejects a contentType containing CR or LF before any fetch (attachments: $attachments)',
    async (overrides) => {
      const fetchMock = stubFetch();

      await expect(
        sendEmail({ ...overrides, contentType: 'text/plain\r\nBcc: attacker@example.com' as SendEmailParams['contentType'] }),
      ).rejects.toMatchObject({ code: 'email.invalid_attachment' });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('writes the attachment message with CRLF only, so no bare LF reaches the wire', async () => {
    const fetchMock = stubFetch();

    await sendEmail({ body: 'line one\nline two\r\nline three', attachments: [attachment(4)] });

    const raw = sentMime(fetchMock).toString('utf8');
    expect(raw).not.toMatch(/(?<!\r)\n/);
    expect(raw).toContain('\r\n\r\nline one\r\nline two\r\nline three\r\n--');
  });
});
