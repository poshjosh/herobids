import crypto from 'node:crypto';
import { UsageBillingRepository, type InsertUsageEvent } from '@herobids/db';
import type { PlansConfig } from '@herobids/domain';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AggregateChatLlmUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cachedInputTokens: number;
  tokensUsed: number;
}

export interface RecordChatLlmUsageInput {
  userId: string;
  threadId: string;
  billingAnchorId: string;
  phase: 'message_send' | 'action_result';
  usage: AggregateChatLlmUsage;
}

// ---------------------------------------------------------------------------
// ChatUsageBillingRecorder
// ---------------------------------------------------------------------------

export class ChatUsageBillingRecorder {
  constructor(
    private readonly repo: UsageBillingRepository,
    private readonly plans: PlansConfig,
    private readonly defaultRateCardName: string,
  ) {}

  async record(input: RecordChatLlmUsageInput): Promise<void> {
    const planId = (await this.repo.getUserPlanId(input.userId)) ?? 'free';

    const planUsage = this.plans.plans[planId]?.usage ?? this.plans.plans['free']?.usage;
    const includedCreditCents = planUsage?.includedCreditCents ?? 0;
    const softCapCents = planUsage?.softCapCents;
    const hardCapCents = planUsage?.hardCapCents;

    // Convert cents to microusd: 1 cent = 10,000 microusd
    const includedCreditMicrousd = includedCreditCents * 10_000;
    const softCapMicrousd = softCapCents != null ? softCapCents * 10_000 : undefined;
    const hardCapMicrousd = hardCapCents != null ? hardCapCents * 10_000 : undefined;

    const account = await this.repo.getOrCreateBillingAccountForUser(
      input.userId,
      planId,
      { softCapMicrousd: softCapMicrousd ?? undefined, hardCapMicrousd: hardCapMicrousd ?? undefined },
    );

    const rateCard = await this.repo.ensureActiveRateCard(this.defaultRateCardName);

    const now = new Date();
    const period = await this.repo.getOrCreateOpenPeriod(
      account.id,
      now,
      account.activePlanId,
      rateCard.id,
      includedCreditMicrousd,
      account.softCapMicrousd,
      account.hardCapMicrousd,
    );

    const rateCardItems = await this.repo.getRateCardItems(rateCard.id);

    const events = this.buildIdempotentEvents(input, account.id, now);

    await this.repo.recordAndRateUsageBatch(events, period.id, account.id, rateCardItems);
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private buildIdempotentEvents(
    input: RecordChatLlmUsageInput,
    accountId: string,
    now: Date,
  ): InsertUsageEvent[] {
    const events: InsertUsageEvent[] = [];
    const idScope = `${input.phase}_${input.billingAnchorId}`;
    const baseEvent = {
      accountId,
      userId: input.userId,
      agentId: null,
      sessionId: input.threadId,
      skillId: null,
      sourceType: 'chat_llm' as const,
      provider: input.usage.provider,
      model: input.usage.model,
      unit: 'tokens',
      occurredAt: now,
    };

    // Non-cached input tokens → llm.input_tokens
    if (input.usage.inputTokens > 0) {
      events.push({
        ...baseEvent,
        id: `ue_${crypto.randomUUID().replace(/-/g, '')}`,
        meterKey: 'llm.input_tokens',
        quantity: input.usage.inputTokens,
        idempotencyKey: `chat_llm_in_${idScope}`,
      });
    }

    // Cached input tokens → llm.cached_input_tokens
    if (input.usage.cachedInputTokens > 0) {
      events.push({
        ...baseEvent,
        id: `ue_${crypto.randomUUID().replace(/-/g, '')}`,
        meterKey: 'llm.cached_input_tokens',
        quantity: input.usage.cachedInputTokens,
        idempotencyKey: `chat_llm_cached_${idScope}`,
      });
    }

    // Output tokens → llm.output_tokens
    if (input.usage.outputTokens > 0) {
      events.push({
        ...baseEvent,
        id: `ue_${crypto.randomUUID().replace(/-/g, '')}`,
        meterKey: 'llm.output_tokens',
        quantity: input.usage.outputTokens,
        idempotencyKey: `chat_llm_out_${idScope}`,
      });
    }

    // Reasoning/thinking tokens → llm.reasoning_tokens
    if (input.usage.thinkingTokens > 0) {
      events.push({
        ...baseEvent,
        id: `ue_${crypto.randomUUID().replace(/-/g, '')}`,
        meterKey: 'llm.reasoning_tokens',
        quantity: input.usage.thinkingTokens,
        idempotencyKey: `chat_llm_reason_${idScope}`,
      });
    }

    // Fallback: only total available → llm.output_tokens with metadata
    if (events.length === 0 && input.usage.tokensUsed > 0) {
      events.push({
        ...baseEvent,
        id: `ue_${crypto.randomUUID().replace(/-/g, '')}`,
        meterKey: 'llm.output_tokens',
        quantity: input.usage.tokensUsed,
        idempotencyKey: `chat_llm_total_${idScope}`,
        metadata: { granularity: 'total_only' },
      });
    }

    return events;
  }
}
