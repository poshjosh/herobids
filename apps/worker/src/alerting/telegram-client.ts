import type { Result } from '@herobids/domain';
import { ok, err } from '@herobids/domain';
import type { JournalEventRow } from './alert-policy.js';
import { classifySeverity } from './alert-policy.js';

export interface TelegramSendResult {
  messageId: number;
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

    try {
      const response = await fetch(`${this.baseUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
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
}

/** Format a journal event into an HTML Telegram message */
function formatAlertMessage(event: JournalEventRow): string {
  const severity = classifySeverity(event.type);
  const icon = severity === 'critical' ? '🚨' : severity === 'warn' ? '⚠️' : 'ℹ️';
  const instanceLabel = event.tradingInstanceId
    ? `\n<b>Instance:</b> <code>${escapeHtml(event.tradingInstanceId.slice(0, 8))}</code>`
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
