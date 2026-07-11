import type { AgentRepository } from '@herobids/db';
import type { TelegramClient } from './telegram-client.js';
import { createLogger } from '../logger.js';

const logger = createLogger('platform-alert-service');

/**
 * Mandatory safety-alert event types.
 * These are platform-authored, always fired regardless of user preferences.
 * The user cannot disable this set in the MVP.
 *
 * Per docs/features/2026/06/06/005-agent-mvp-rollout-plan/001-mvp-delivery-plan.md:
 * 1. runtime unhealthy or heartbeat lost beyond threshold
 * 2. runtime failed to start or crashed
 * 3. agent paused or stopped by a guardrail or platform safety rule
 * 4. critical execution or reconciliation failure requiring operator attention
 */
export const PLATFORM_ALERT_EVENTS = {
  RUNTIME_UNHEALTHY: 'agent.runtime.unhealthy',
  RUNTIME_FAILED: 'agent.runtime.failed',
  PAUSED_BY_GUARDRAIL: 'agent.paused_by_guardrail',
  EXECUTION_CRITICAL_FAILURE: 'agent.execution_critical_failure',
} as const;

export type PlatformAlertEvent = typeof PLATFORM_ALERT_EVENTS[keyof typeof PLATFORM_ALERT_EVENTS];

export interface PlatformAlertContext {
  agentId: string;
  agentName?: string;
  sessionId?: string;
  message: string;
  detail?: string;
  crashType?: string;
}

/**
 * PlatformAlertService — delivers mandatory safety alerts to users via Telegram.
 *
 * Authorship is always 'platform'. Messages are clearly labeled to distinguish
 * them from agent-authored messages. The user cannot opt out of this alert set.
 *
 * Delivery failure is logged but does not crash the caller — the platform must
 * remain operational even if Telegram is unreachable.
 */
export class PlatformAlertService {
  constructor(
    private readonly agentRepo: AgentRepository,
    private readonly telegram: TelegramClient | undefined,
    _botToken: string | undefined,
  ) {}

  /**
   * Fire a mandatory safety alert to the user who owns the given agent.
   * Resolves the effective Telegram chat ID (agent-level override > user-level default) and sends a platform-authored message.
   * Persists to agent_outbound_messages with authored_by='platform'.
   */
  async fireAlert(event: PlatformAlertEvent, ctx: PlatformAlertContext): Promise<void> {
    // Always persist first so the UI message feed and audit trail are complete
    // regardless of delivery outcome. Skipped delivery is not the same as no alert.
    const msgId = await this.agentRepo.insertOutboundMessage({
      agentId: ctx.agentId,
      sessionId: ctx.sessionId,
      authoredBy: 'platform',
      subject: eventSubject(event),
      body: ctx.message + (ctx.detail ? `\n\n${ctx.detail}` : ''),
      contextRef: ctx.sessionId,
    }).catch((err: unknown) => {
      logger.warn({ err, agentId: ctx.agentId }, 'Failed to persist platform alert record');
      return null;
    });

    if (!this.telegram) {
      logger.debug({ event, agentId: ctx.agentId }, 'Platform alert persisted — Telegram not configured, skipping delivery');
      if (msgId) {
        await this.agentRepo.markOutboundMessageFailed(msgId, 'telegram_not_configured').catch(() => undefined);
      }
      return;
    }

    const telegramChatId = await this.agentRepo.getEffectiveTelegramChatId(ctx.agentId).catch((err: unknown) => {
      logger.warn({ err, agentId: ctx.agentId }, 'Failed to look up effective Telegram chat ID');
      return null;
    });

    if (!telegramChatId) {
      logger.info({ event, agentId: ctx.agentId }, 'Platform alert persisted — no Telegram chat ID available, skipping delivery');
      if (msgId) {
        await this.agentRepo.markOutboundMessageFailed(msgId, 'no_telegram_chat_id').catch(() => undefined);
      }
      return;
    }

    const text = formatPlatformAlert(event, ctx);
    const result = await this.telegram.sendText(telegramChatId, text);
    if (!result.ok) {
      logger.warn({ event, agentId: ctx.agentId, error: result.error }, 'Platform alert Telegram delivery failed');
      if (msgId) {
        await this.agentRepo.markOutboundMessageFailed(msgId, result.error.message).catch(() => undefined);
      }
      return;
    }

    if (msgId) {
      await this.agentRepo.markOutboundMessageSent(msgId, String(result.data.messageId), telegramChatId).catch(() => undefined);
    }

    logger.info({ event, agentId: ctx.agentId }, 'Platform safety alert sent');
  }
}

function eventSubject(event: PlatformAlertEvent): string {
  switch (event) {
    case PLATFORM_ALERT_EVENTS.RUNTIME_UNHEALTHY: return 'Runtime Unhealthy';
    case PLATFORM_ALERT_EVENTS.RUNTIME_FAILED: return 'Runtime Failed';
    case PLATFORM_ALERT_EVENTS.PAUSED_BY_GUARDRAIL: return 'Agent Paused by Guardrail';
    case PLATFORM_ALERT_EVENTS.EXECUTION_CRITICAL_FAILURE: return 'Critical Execution Failure';
  }
}

function formatPlatformAlert(event: PlatformAlertEvent, ctx: PlatformAlertContext): string {
  const subject = eventSubject(event);
  const agentLabel = ctx.agentName ? escapeHtml(ctx.agentName) : `<code>${escapeHtml(ctx.agentId.slice(0, 8))}</code>`;
  const detail = ctx.detail ? `\n<i>${escapeHtml(ctx.detail.slice(0, 300))}</i>` : '';

  return [
    `🔔 <b>[HeroBids Safety Alert]</b>`,
    `<b>${escapeHtml(subject)}</b>`,
    `Agent: ${agentLabel}`,
    escapeHtml(ctx.message),
    detail,
  ].filter(Boolean).join('\n');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
