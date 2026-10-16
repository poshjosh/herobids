import type { Result } from '@herobids/domain';
import { createLogger } from '../logger.js';
import { escapeHtml } from './platform-alert-service.js';

const logger = createLogger('operator-notifier');

export interface PlatformFaultReport {
  agentId: string;
  agentName?: string;
  toolName: string;
  errorCode?: string;
  summary?: string;
}

interface TextSender {
  sendText(chatId: string, text: string): Promise<Result<unknown, { code: string; message: string }>>;
}

/**
 * Tells the platform operator about a fault the user cannot fix.
 * Reports for the same agent and error code are throttled by a cooldown.
 */
export class OperatorNotifier {
  private readonly lastSentAt = new Map<string, number>();

  constructor(
    private readonly sender: TextSender,
    private readonly chatId: string,
    private readonly cooldownMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async reportPlatformFault(report: PlatformFaultReport): Promise<void> {
    const key = `${report.agentId}:${report.errorCode ?? report.toolName}`;
    const last = this.lastSentAt.get(key);
    const now = this.now();
    if (last !== undefined && now - last < this.cooldownMs) return;

    this.lastSentAt.set(key, now);
    const result = await this.sender.sendText(this.chatId, formatReport(report));
    if (!result.ok) {
      this.lastSentAt.delete(key);
      logger.warn({ err: result.error, agentId: report.agentId }, 'Failed to send platform fault report');
    }
  }
}

function formatReport(report: PlatformFaultReport): string {
  const agent = report.agentName
    ? `${escapeHtml(report.agentName)} (<code>${escapeHtml(report.agentId)}</code>)`
    : `<code>${escapeHtml(report.agentId)}</code>`;
  return [
    '<b>Platform fault reported by an agent</b>',
    `Agent: ${agent}`,
    `Tool: <code>${escapeHtml(report.toolName)}</code>`,
    report.errorCode ? `Code: <code>${escapeHtml(report.errorCode)}</code>` : undefined,
    report.summary ? `<i>${escapeHtml(report.summary.slice(0, 300))}</i>` : undefined,
  ].filter(Boolean).join('\n');
}
