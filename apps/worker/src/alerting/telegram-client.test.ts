import { describe, it, expect, vi, afterEach } from 'vitest';
import { TelegramClient, forceReply } from './telegram-client.js';

const BASE_URL = 'https://api.telegram.org/bottest-token';

function telegramResponse(body: Record<string, unknown>, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
    json: vi.fn().mockResolvedValue(body),
  };
}

function stubFetch(...responses: Array<ReturnType<typeof telegramResponse>>) {
  const fetchMock = vi.fn();
  for (const response of responses) fetchMock.mockResolvedValueOnce(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>, callIndex: number): FormData | string {
  return (fetchMock.mock.calls[callIndex]?.[1] as RequestInit | undefined)?.body as FormData | string;
}

describe('TelegramClient.sendDocument', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uploads the file bytes as multipart with filename and mime type', async () => {
    const fetchMock = stubFetch(telegramResponse({ ok: true, result: { message_id: 7 } }));
    const bytes = Buffer.from('%PDF-1.4 test bytes');

    const client = new TelegramClient('test-token');
    const result = await client.sendDocument({
      chatId: 'chat-123',
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      body: bytes,
    });

    expect(result).toEqual({ ok: true, data: { messageId: 7 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`${BASE_URL}/sendDocument`, expect.objectContaining({ method: 'POST' }));

    const form = requestBody(fetchMock, 0);
    expect(form).toBeInstanceOf(FormData);
    const formData = form as FormData;
    expect(formData.get('chat_id')).toBe('chat-123');
    expect(formData.get('caption')).toBeNull();

    const file = formData.get('document') as File;
    expect(file.name).toBe('report.pdf');
    expect(file.type).toBe('application/pdf');
    expect(Buffer.from(await file.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it('sends the caption as HTML on the document without a separate text message', async () => {
    const fetchMock = stubFetch(telegramResponse({ ok: true, result: { message_id: 8 } }));

    const client = new TelegramClient('test-token');
    const result = await client.sendDocument({
      chatId: 'chat-123',
      filename: 'notes.txt',
      mimeType: 'text/plain',
      body: Buffer.from('hello'),
      caption: 'Here is the file',
    });

    expect(result).toEqual({ ok: true, data: { messageId: 8 } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const form = requestBody(fetchMock, 0) as FormData;
    expect(form.get('caption')).toBe('Here is the file');
    expect(form.get('parse_mode')).toBe('HTML');
  });

  it('attaches reply markup to the document message', async () => {
    const fetchMock = stubFetch(telegramResponse({ ok: true, result: { message_id: 9 } }));

    const client = new TelegramClient('test-token');
    await client.sendDocument({
      chatId: 'chat-123',
      filename: 'notes.txt',
      mimeType: 'text/plain',
      body: Buffer.from('hello'),
      replyMarkup: forceReply(),
    });

    const form = requestBody(fetchMock, 0) as FormData;
    expect(JSON.parse(form.get('reply_markup') as string)).toEqual(forceReply());
  });

  it('keeps a caption of exactly 1024 UTF-16 units on the document', async () => {
    const fetchMock = stubFetch(telegramResponse({ ok: true, result: { message_id: 10 } }));
    const caption = 'a'.repeat(1024);

    const client = new TelegramClient('test-token');
    await client.sendDocument({
      chatId: 'chat-123',
      filename: 'notes.txt',
      mimeType: 'text/plain',
      body: Buffer.from('hello'),
      caption,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const form = requestBody(fetchMock, 0) as FormData;
    expect(form.get('caption')).toBe(caption);
  });

  it('keeps a caption of 512 emoji (1024 UTF-16 units) on the document', async () => {
    const fetchMock = stubFetch(telegramResponse({ ok: true, result: { message_id: 14 } }));
    const caption = '😀'.repeat(512);

    const client = new TelegramClient('test-token');
    await client.sendDocument({
      chatId: 'chat-123',
      filename: 'notes.txt',
      mimeType: 'text/plain',
      body: Buffer.from('hello'),
      caption,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const form = requestBody(fetchMock, 0) as FormData;
    expect(form.get('caption')).toBe(caption);
  });

  it('sends a caption of 513 emoji (1026 UTF-16 units) as overflow text, then the document uncaptioned', async () => {
    const fetchMock = stubFetch(
      telegramResponse({ ok: true, result: { message_id: 15 } }),
      telegramResponse({ ok: true, result: { message_id: 16 } }),
    );
    const caption = '😀'.repeat(513);

    const client = new TelegramClient('test-token');
    await client.sendDocument({
      chatId: 'chat-123',
      filename: 'notes.txt',
      mimeType: 'text/plain',
      body: Buffer.from('hello'),
      caption,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE_URL}/sendMessage`);
    expect(JSON.parse(requestBody(fetchMock, 0) as string).text).toBe(caption);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`${BASE_URL}/sendDocument`);
    expect((requestBody(fetchMock, 1) as FormData).get('caption')).toBeNull();
  });

  it('HTML-escapes the caption so Telegram renders it literally', async () => {
    const fetchMock = stubFetch(telegramResponse({ ok: true, result: { message_id: 17 } }));

    const client = new TelegramClient('test-token');
    const result = await client.sendDocument({
      chatId: 'chat-123',
      filename: 'notes.txt',
      mimeType: 'text/plain',
      body: Buffer.from('hello'),
      caption: 'a < b & c',
    });

    expect(result).toEqual({ ok: true, data: { messageId: 17 } });
    const form = requestBody(fetchMock, 0) as FormData;
    expect(form.get('caption')).toBe('a &lt; b &amp; c');
  });

  it('escapes overflow text exactly once', async () => {
    const fetchMock = stubFetch(
      telegramResponse({ ok: true, result: { message_id: 18 } }),
      telegramResponse({ ok: true, result: { message_id: 19 } }),
    );
    const caption = 'a < b & '.repeat(100);

    const client = new TelegramClient('test-token');
    await client.sendDocument({
      chatId: 'chat-123',
      filename: 'notes.txt',
      mimeType: 'text/plain',
      body: Buffer.from('hello'),
      caption,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const text = JSON.parse(requestBody(fetchMock, 0) as string).text as string;
    expect(text).toBe('a &lt; b &amp; '.repeat(100));
    expect(text).toContain('&lt;');
    expect(text).toContain('&amp;');
    expect(text).not.toContain('&amp;lt;');
  });

  it('splits overflow text into chunks of at most 4096 escaped units, then sends the document uncaptioned', async () => {
    const fetchMock = stubFetch(
      telegramResponse({ ok: true, result: { message_id: 20 } }),
      telegramResponse({ ok: true, result: { message_id: 21 } }),
      telegramResponse({ ok: true, result: { message_id: 22 } }),
    );

    const client = new TelegramClient('test-token');
    const result = await client.sendDocument({
      chatId: 'chat-123',
      filename: 'notes.txt',
      mimeType: 'text/plain',
      body: Buffer.from('hello'),
      caption: '<'.repeat(2000),
    });

    expect(result).toEqual({ ok: true, data: { messageId: 22 } });
    const calls = fetchMock.mock.calls;
    expect(calls.length).toBeGreaterThan(2);

    const textCalls = calls.slice(0, -1);
    for (const [url] of textCalls) expect(url).toBe(`${BASE_URL}/sendMessage`);
    const texts = textCalls.map((_, i) => JSON.parse(requestBody(fetchMock, i) as string).text as string);
    for (const text of texts) expect(text.length).toBeLessThanOrEqual(4096);
    expect(texts.join('')).toBe('&lt;'.repeat(2000));

    expect(calls[calls.length - 1]?.[0]).toBe(`${BASE_URL}/sendDocument`);
    expect((requestBody(fetchMock, calls.length - 1) as FormData).get('caption')).toBeNull();
  });

  it('does not upload the document when a text chunk fails', async () => {
    const fetchMock = stubFetch(
      telegramResponse({ ok: true, result: { message_id: 23 } }),
      telegramResponse({ ok: false, description: 'Bad Request: message is too long' }),
    );

    const client = new TelegramClient('test-token');
    const result = await client.sendDocument({
      chatId: 'chat-123',
      filename: 'notes.txt',
      mimeType: 'text/plain',
      body: Buffer.from('hello'),
      caption: '<'.repeat(2000),
    });

    expect(result).toEqual({ ok: false, error: { code: 'telegram.api_error', message: 'Bad Request: message is too long' } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [url] of fetchMock.mock.calls) expect(url).toBe(`${BASE_URL}/sendMessage`);
  });

 it('sends a caption over 1024 UTF-16 units as a full text message first, then the document uncaptioned', async () => {
    const fetchMock = stubFetch(
      telegramResponse({ ok: true, result: { message_id: 11 } }),
      telegramResponse({ ok: true, result: { message_id: 12 } }),
    );
    const longText = 'b'.repeat(1025);

    const client = new TelegramClient('test-token');
    const result = await client.sendDocument({
      chatId: 'chat-123',
      filename: 'notes.txt',
      mimeType: 'text/plain',
      body: Buffer.from('hello'),
      caption: longText,
    });

    expect(result).toEqual({ ok: true, data: { messageId: 12 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE_URL}/sendMessage`);
    expect(JSON.parse(requestBody(fetchMock, 0) as string).text).toBe(longText);

    expect(fetchMock.mock.calls[1]?.[0]).toBe(`${BASE_URL}/sendDocument`);
    const form = requestBody(fetchMock, 1) as FormData;
    expect(form.get('caption')).toBeNull();
  });

  it('does not upload the document when the overflow text message fails', async () => {
    const fetchMock = stubFetch(telegramResponse({ ok: false, description: 'Bad Request: chat not found' }));

    const client = new TelegramClient('test-token');
    const result = await client.sendDocument({
      chatId: 'chat-123',
      filename: 'notes.txt',
      mimeType: 'text/plain',
      body: Buffer.from('hello'),
      caption: 'c'.repeat(1025),
    });

    expect(result).toEqual({ ok: false, error: { code: 'telegram.api_error', message: 'Bad Request: chat not found' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BASE_URL}/sendMessage`);
  });

  it('returns the same error shape as sendText for a Telegram API error', async () => {
    const description = 'Bad Request: wrong file identifier';
    stubFetch(telegramResponse({ ok: false, description }));
    const client = new TelegramClient('test-token');
    const documentResult = await client.sendDocument({
      chatId: 'chat-123',
      filename: 'notes.txt',
      mimeType: 'text/plain',
      body: Buffer.from('hello'),
    });

    vi.unstubAllGlobals();
    stubFetch(telegramResponse({ ok: false, description }));
    const textResult = await client.sendText('chat-123', 'hello');

    expect(documentResult).toEqual({ ok: false, error: { code: 'telegram.api_error', message: description } });
    expect(documentResult).toEqual(textResult);
  });

  it('returns telegram.http_error for a non-2xx response', async () => {
    stubFetch(telegramResponse({ ok: false, description: 'Too Large' }, 413));

    const client = new TelegramClient('test-token');
    const result = await client.sendDocument({
      chatId: 'chat-123',
      filename: 'notes.txt',
      mimeType: 'text/plain',
      body: Buffer.from('hello'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('telegram.http_error');
      expect(result.error.message).toContain('HTTP 413');
    }
  });

  it('returns telegram.network_error when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket hang up')));

    const client = new TelegramClient('test-token');
    const result = await client.sendDocument({
      chatId: 'chat-123',
      filename: 'notes.txt',
      mimeType: 'text/plain',
      body: Buffer.from('hello'),
    });

    expect(result).toEqual({ ok: false, error: { code: 'telegram.network_error', message: 'socket hang up' } });
  });
});
