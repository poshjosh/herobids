import type { AgentRepository } from '@herobids/db';
import { renderEmail, type ConversationService } from '@herobids/domain';
import type { ChatDelivery } from './chat-delivery.js';
import type { EmailClient } from './email-client.js';
import { createLogger } from '../logger.js';
import { markThreadDelivery } from '../thread-delivery.js';

const logger = createLogger('platform-alert-service');

/** Truncate text at the last word boundary before maxLen, appending nothing. */
function truncateAtWord(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const sliced = text.slice(0, maxLen);
  const lastSpace = sliced.lastIndexOf(' ');
  return lastSpace > 0 ? sliced.slice(0, lastSpace) : sliced;
}

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
  CRASH_LOOP_BLOCKED: 'agent.runtime.crash_loop_blocked',
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
    private readonly chatDelivery: ChatDelivery | undefined,
    _botToken: string | undefined,
    private readonly emailClient?: EmailClient,
    private readonly brandImageUrl?: string,
    private readonly conversations?: Pick<ConversationService, 'recordPlatformMessage' | 'markDelivery'>,
  ) {}

  /**
   * Fire a mandatory safety alert to the user who owns the given agent.
   * Resolves the effective Telegram chat ID (agent-level override > user-level default) and sends a platform-authored message.
   * Records the alert in the agent's conversation (sender `platform`) before delivery, then marks its delivery.
   */
  async fireAlert(event: PlatformAlertEvent, ctx: PlatformAlertContext): Promise<void> {
    // Always record first so the thread and audit trail are complete regardless of delivery outcome.
    // Skipped delivery is not the same as no alert. A recording failure never blocks the alert itself.
    const msgId = await this.recordInThread(event, ctx);

    let anyDelivered = false;

    // Deliver via chat
    if (this.chatDelivery) {
      const text = formatPlatformAlert(event, ctx);
      const result = await this.chatDelivery.send(ctx.agentId, { body: text });
      if (result.ok) {
        anyDelivered = true;
      } else if (result.error.code === 'chat.address_lookup_failed') {
        logger.warn({ event, agentId: ctx.agentId, error: result.error }, 'Platform alert chat address lookup failed');
      } else if (result.error.code !== 'chat.no_address') {
        logger.warn({ event, agentId: ctx.agentId, error: result.error }, 'Platform alert Telegram delivery failed');
      }
      if (msgId && this.conversations) await markThreadDelivery(this.conversations, msgId, result);
    } else {
      logger.debug({ event, agentId: ctx.agentId }, 'Platform alert — Telegram not configured, skipping Telegram delivery');
      if (msgId && this.conversations) {
        await markThreadDelivery(this.conversations, msgId, { ok: false, error: { code: 'chat.not_configured', message: 'telegram_not_configured' } });
      }
    }

    // Deliver via Email
    if (this.emailClient) {
      const recipientEmail = await this.agentRepo.getUserEmailByAgentId(ctx.agentId).catch((err: unknown) => {
        logger.warn({ err, agentId: ctx.agentId }, 'Failed to look up user email for platform alert');
        return null;
      });

      if (recipientEmail) {
        const subject = eventSubject(event);
        const rendered = renderEmail({
          subject: `[Safety Alert] ${subject}`,
          preheader: ctx.message.slice(0, 100),
          title: subject,
          body: [
            ctx.message,
            ctx.detail ? `\nDetails: ${truncateAtWord(ctx.detail, 500)}` : '',
          ].filter(Boolean).join('\n'),
          footerNote: ctx.agentName
            ? `Agent: ${ctx.agentName} (${ctx.agentId.slice(0, 8)})`
            : `Agent ID: ${ctx.agentId.slice(0, 8)}`,
          ...(this.brandImageUrl ? { brandImageUrl: this.brandImageUrl } : {}),
        });

        const emailResult = await this.emailClient.send({
          to: recipientEmail,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
        });

        if (emailResult.ok) {
          anyDelivered = true;
          logger.info({ event, agentId: ctx.agentId, email: recipientEmail }, 'Platform safety alert sent via email');
        } else {
          logger.warn({ event, agentId: ctx.agentId, error: emailResult.error }, 'Platform safety alert email delivery failed');
        }
      } else {
        logger.info({ event, agentId: ctx.agentId }, 'Platform alert — no user email available, skipping email delivery');
      }
    }

    if (anyDelivered) {
      logger.info({ event, agentId: ctx.agentId }, 'Platform safety alert sent');
    } else {
      logger.warn({ event, agentId: ctx.agentId }, 'Platform safety alert could not be delivered via any channel');
    }
  }

  private async recordInThread(event: PlatformAlertEvent, ctx: PlatformAlertContext): Promise<string | null> {
    if (!this.conversations) return null;
    try {
      const agent = await this.agentRepo.getAgent(ctx.agentId);
      if (!agent) return null;
      const recorded = await this.conversations.recordPlatformMessage({
        ownerUserId: agent.userId,
        agentId: ctx.agentId,
        channel: 'web',
        messageClass: 'alert',
        subject: eventSubject(event),
        body: ctx.message + (ctx.detail ? `\n\n${ctx.detail}` : ''),
      });
      if (recorded.ok) return recorded.data.message.id;
      logger.warn({ agentId: ctx.agentId, code: recorded.error.code }, 'Failed to record platform alert in the thread');
    } catch (err) {
      logger.warn({ err, agentId: ctx.agentId }, 'Failed to record platform alert in the thread');
    }
    return null;
  }
}

function eventSubject(event: PlatformAlertEvent): string {
  switch (event) {
    case PLATFORM_ALERT_EVENTS.RUNTIME_UNHEALTHY: return 'Runtime Unhealthy';
    case PLATFORM_ALERT_EVENTS.RUNTIME_FAILED: return 'Runtime Failed';
    case PLATFORM_ALERT_EVENTS.PAUSED_BY_GUARDRAIL: return 'Agent Paused by Guardrail';
    case PLATFORM_ALERT_EVENTS.EXECUTION_CRITICAL_FAILURE: return 'Critical Execution Failure';
    case PLATFORM_ALERT_EVENTS.CRASH_LOOP_BLOCKED: return 'Agent Crash Loop Blocked';
  }
}

function formatPlatformAlert(event: PlatformAlertEvent, ctx: PlatformAlertContext): string {
  const subject = eventSubject(event);
  const agentLabel = ctx.agentName ? escapeHtml(ctx.agentName) : `<code>${escapeHtml(ctx.agentId.slice(0, 8))}</code>`;
  const detail = ctx.detail ? `\n<i>${escapeHtml(ctx.detail.slice(0, 300))}</i>` : '';

  return [
    `🔔 <b>[OpenAIdom Safety Alert]</b>`,
    `<b>${escapeHtml(subject)}</b>`,
    `Agent: ${agentLabel}`,
    escapeHtml(ctx.message),
    detail,
  ].filter(Boolean).join('\n');
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
