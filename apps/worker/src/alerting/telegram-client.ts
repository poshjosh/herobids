import type { Result } from '@herobids/domain';
import { ok, err } from '@herobids/domain';
import type { JournalEventRow } from './alert-policy.js';
import { classifySeverity } from './alert-policy.js';

export interface TelegramSendResult {
  messageId: number;
}

export type TelegramReplyMarkup = Record<string, unknown>;

/** Telegram rejects captions longer than this (counted in UTF-16 units, as JS `length` does). */
export const TELEGRAM_CAPTION_MAX_CHARS = 1024;

/** Telegram rejects sendMessage text longer than this. */
const TELEGRAM_MESSAGE_MAX_CHARS = 4096;

export function forceReply(): TelegramReplyMarkup {
  return {
    force_reply: true,
    selective: true,
  };
}

/**
 * Minimal Telegram Bot API client for sending alert messages.
 * Uses the sendMessage endpoint only.
 */
export class TelegramClient {
  private readonly baseUrl: string;

  constructor(private readonly botToken: string) {
    this.baseUrl = `https://api.telegram.org/bot${this.botToken}`;
  }

  /** Send a formatted alert message to a chat. */
  async sendAlert(chatId: string, event: JournalEventRow): Promise<Result<TelegramSendResult, { code: string; message: string }>> {
    const text = formatAlertMessage(event);
    return this.sendText(chatId, text);
  }

  /** Send a plain HTML text message directly to a chat. */
  async sendText(chatId: string, text: string, replyMarkup?: TelegramReplyMarkup): Promise<Result<TelegramSendResult, { code: string; message: string }>> {
    try {
      const response = await fetch(`${this.baseUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        return err({ code: 'telegram.http_error', message: `HTTP ${response.status}: ${body}` });
      }

      const data = await response.json() as { ok: boolean; result?: { message_id: number }; description?: string };
      if (!data.ok) {
        return err({ code: 'telegram.api_error', message: data.description ?? 'Unknown Telegram API error' });
      }

      return ok({ messageId: data.result!.message_id });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return err({ code: 'telegram.network_error', message });
    }
  }

  /**
   * Upload a file to a chat via multipart/form-data.
   * `caption` is plain text; it is HTML-escaped before sending (parse_mode HTML).
   * The 1024-unit limit is checked against the escaped text, which over-counts entities and is conservative.
   * Captions over the limit are sent first as text messages, split into chunks of at most 4096 escaped units
   * (each chunk is escaped separately so no entity is split), never truncated.
   * Returns the document message's id.
   */
  async sendDocument(params: {
    chatId: string;
    filename: string;
    mimeType: string;
    body: Buffer;
    caption?: string;
    replyMarkup?: TelegramReplyMarkup;
  }): Promise<Result<TelegramSendResult, { code: string; message: string }>> {
    let caption = params.caption ? escapeHtml(params.caption) : undefined;
    if (caption && caption.length > TELEGRAM_CAPTION_MAX_CHARS) {
      for (const chunk of splitIntoEscapedChunks(params.caption ?? '', TELEGRAM_MESSAGE_MAX_CHARS)) {
        const textResult = await this.sendText(params.chatId, escapeHtml(chunk));
        if (!textResult.ok) return textResult;
      }
      caption = undefined;
    }

    try {
      const form = new FormData();
      form.append('chat_id', params.chatId);
      form.append('document', new Blob([new Uint8Array(params.body)], { type: params.mimeType }), params.filename);
      if (caption) {
        form.append('caption', caption);
        form.append('parse_mode', 'HTML');
      }
      if (params.replyMarkup) {
        form.append('reply_markup', JSON.stringify(params.replyMarkup));
      }

      const response = await fetch(`${this.baseUrl}/sendDocument`, {
        method: 'POST',
        body: form,
      });

      if (!response.ok) {
        const body = await response.text();
        return err({ code: 'telegram.http_error', message: `HTTP ${response.status}: ${body}` });
      }

      const data = await response.json() as { ok: boolean; result?: { message_id: number }; description?: string };
      if (!data.ok) {
        return err({ code: 'telegram.api_error', message: data.description ?? 'Unknown Telegram API error' });
      }

      return ok({ messageId: data.result!.message_id });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return err({ code: 'telegram.network_error', message });
    }
  }

  async setWebhook(url: string, secretToken: string): Promise<Result<undefined, { code: string; message: string }>> {
    try {
      const response = await fetch(`${this.baseUrl}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          secret_token: secretToken,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        return err({ code: 'telegram.http_error', message: `HTTP ${response.status}: ${body}` });
      }

      const data = await response.json() as { ok: boolean; description?: string };
      if (!data.ok) {
        return err({ code: 'telegram.api_error', message: data.description ?? 'Unknown Telegram API error' });
      }

      return ok(undefined);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return err({ code: 'telegram.network_error', message });
    }
  }

  /** Register supported bot commands so they appear in the Telegram client command picker. */
  async setMyCommands(commands: Array<{ command: string; description: string }>): Promise<Result<undefined, { code: string; message: string }>> {
    try {
      const response = await fetch(`${this.baseUrl}/setMyCommands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commands }),
      });

      if (!response.ok) {
        const body = await response.text();
        return err({ code: 'telegram.http_error', message: `HTTP ${response.status}: ${body}` });
      }

      const data = await response.json() as { ok: boolean; description?: string };
      if (!data.ok) {
        return err({ code: 'telegram.api_error', message: data.description ?? 'Unknown Telegram API error' });
      }

      return ok(undefined);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return err({ code: 'telegram.network_error', message });
    }
  }
}

/** Format a journal event into an HTML Telegram message */
function formatAlertMessage(event: JournalEventRow): string {
  const severity = classifySeverity(event.type);
  const icon = severity === 'critical' ? '🚨' : severity === 'warn' ? '⚠️' : 'ℹ️';
  const instanceLabel = event.actorId
    ? `\n<b>Actor:</b> <code>${escapeHtml(event.actorId.slice(0, 8))}</code>`
    : '';

  const payloadSummary = summarizePayload(event.payload);

  return [
    `${icon} <b>${escapeHtml(event.type)}</b>`,
    instanceLabel,
    payloadSummary ? `\n${payloadSummary}` : '',
    `\n<i>${event.createdAt.toISOString()}</i>`,
  ].join('');
}

function summarizePayload(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  if (payload['message'] && typeof payload['message'] === 'string') {
    parts.push(escapeHtml(payload['message'].slice(0, 200)));
  }
  if (payload['reason'] && typeof payload['reason'] === 'string') {
    parts.push(`Reason: ${escapeHtml(payload['reason'].slice(0, 100))}`);
  }
  if (payload['error'] && typeof payload['error'] === 'string') {
    parts.push(`Error: ${escapeHtml(payload['error'].slice(0, 100))}`);
  }
  return parts.join('\n');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Split raw text into chunks whose HTML-escaped length is at most `maxEscapedLength`.
 * Iterates by code point so surrogate pairs are never cut; escaping is per character,
 * so the escaped length of a chunk is the sum of its code points' escaped lengths.
 */
function splitIntoEscapedChunks(text: string, maxEscapedLength: number): string[] {
  const chunks: string[] = [];
  let current = '';
  let currentEscapedLength = 0;
  for (const char of text) {
    const escapedLength = escapeHtml(char).length;
    if (currentEscapedLength + escapedLength > maxEscapedLength) {
      chunks.push(current);
      current = '';
      currentEscapedLength = 0;
    }
    current += char;
    currentEscapedLength += escapedLength;
  }
  if (current) chunks.push(current);
  return chunks;
}
