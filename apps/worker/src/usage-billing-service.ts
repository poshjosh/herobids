/**
 * Worker-side usage billing service.
 *
 * Runs inside the agent container process. Writes commercial usage events to
 * the billing tables synchronously with each LLM call and in coarse runtime
 * windows. All writes are fire-and-forget with error logging — billing
 * failures must never crash the agent loop.
 */

import crypto from 'node:crypto';
import { createLogger } from './logger.js';
import { UsageBillingRepository } from '@herobids/db';
import type { Database } from '@herobids/db';
import type { ProvidersYaml } from '@herobids/domain';

const logger = createLogger('usage-billing-service');

function getBillingMonthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface UsageBillingServiceConfig {
  userId: string;
  agentId: string;
  sessionId: string;
  skillId?: string | null;
  planId?: string;
  includedCreditMicrousd?: number;
  softCapMicrousd?: number | null;
  hardCapMicrousd?: number | null;
  defaultRateCardName: string;
  runtimeChargeWindowMs: number;
  rateCardItems?: Array<{ meterKey: string; priceMicrousd: number; perUnit: number }>;
  providersYaml?: ProvidersYaml;
  /** Percentage of input rate to use as cache-read rate when no explicit price is available */
  fallbackCacheReadPct?: number;
  /** Percentage of maxTokens to bill as estimated output on failed LLM calls */
  failedRequestOutputPct?: number;
  enabled: boolean;
}

export interface LlmUsageInput {
  provider: string;
  model: string;
  responseId?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  thinkingTokens?: number | null;
  cachedInputTokens?: number | null;
  tokensUsed?: number;
  phase: string;
  turnIndex?: number;
}

export class UsageBillingService {
  private readonly repo: UsageBillingRepository;
  private accountId: string | null = null;
  private periodId: string | null = null;
  private periodMonthKey: string | null = null;
  private rateCardId: string | null = null;
  private runtimeWindowStartAt: number = Date.now();
  private accountLoaded = false;

  constructor(
    db: Database,
    private readonly config: UsageBillingServiceConfig,
  ) {
    this.repo = new UsageBillingRepository(db, config.rateCardItems, config.providersYaml, config.fallbackCacheReadPct);
  }

  /** Lazily resolve billing account and open period. Returns false if unavailable. */
  private async ensureAccount(now: Date = new Date()): Promise<boolean> {

    try {
      if (!this.accountLoaded) {
        const account = await this.repo.getOrCreateBillingAccountForUser(
          this.config.userId,
          this.config.planId ?? 'free',
          {
            softCapMicrousd: this.config.softCapMicrousd,
            hardCapMicrousd: this.config.hardCapMicrousd,
          },
        );
        this.accountId = account.id;

        const rateCard = await this.repo.ensureActiveRateCard(this.config.defaultRateCardName);
        this.rateCardId = rateCard?.id ?? null;
        this.accountLoaded = true;
      }

      if (!this.accountId) {
        return false;
      }

      const monthKey = getBillingMonthKey(now);
      if (this.rateCardId && (this.periodId === null || this.periodMonthKey !== monthKey)) {
        const account = await this.repo.getAccountByUserId(this.config.userId);
        if (!account) {
          throw new Error(`Billing account ${this.accountId} disappeared while recording usage`);
        }

        const period = await this.repo.getOrCreateOpenPeriod(
          account.id,
          now,
          account.activePlanId,
          this.rateCardId,
          this.config.includedCreditMicrousd ?? 0,
          account.softCapMicrousd ?? null,
          account.hardCapMicrousd ?? null,
        );
        this.periodId = period.id;
        this.periodMonthKey = monthKey;
      }

      return true;
    } catch (err) {
      logger.warn({ err }, 'Failed to resolve billing account — skipping usage recording');
      return false;
    }
  }

  /** Check whether the account is hard-limited. Returns false (allow) on error. */
  async isHardLimited(): Promise<boolean> {
    if (!this.config.enabled) return false;
    try {
      const ok = await this.ensureAccount();
      if (!ok || !this.accountId) return false;

      const state = await this.repo.getSpendState(this.accountId);
      return state?.status === 'hard_limited' || state?.status === 'suspended';
    } catch {
      return false;
    }
  }

  /** Check whether the account is soft-limited. Returns false on error. */
  async isSoftLimited(): Promise<boolean> {
    if (!this.config.enabled) return false;
    try {
      const ok = await this.ensureAccount();
      if (!ok || !this.accountId) return false;

      const state = await this.repo.getSpendState(this.accountId);
      return state?.status === 'soft_limited';
    } catch {
      return false;
    }
  }

  /**
   * Check whether paid work is allowed right now.
   * Delegates to UsageBillingRepository.canSpendNow.
   * Returns { canSpend: true, ... } on error (fail-open for billing) after logging.
   */
  async canSpendNow(): Promise<import('@herobids/db').CanSpendNowResult> {
    if (!this.config.enabled) {
      return { canSpend: true, availableMicrousd: 0, hardCapMicrousd: null, status: 'active', reason: 'ok' };
    }
    try {
      const ok = await this.ensureAccount();
      if (!ok || !this.accountId) {
        return { canSpend: true, availableMicrousd: 0, hardCapMicrousd: null, status: 'active', reason: 'ok' };
      }
      return await this.repo.canSpendNow(this.accountId);
    } catch (err) {
      logger.warn({ err }, 'Failed to check canSpendNow — allowing spend (fail-open)');
      return { canSpend: true, availableMicrousd: 0, hardCapMicrousd: null, status: 'active', reason: 'ok' };
    }
  }

  /** Record LLM usage events from a provider response. Fire-and-forget. */
  recordLlmUsage(input: LlmUsageInput): void {
    if (!this.config.enabled) return;

    void this.doRecordLlmUsage(input).catch((err: unknown) => {
      logger.warn({ err, phase: input.phase }, 'Failed to record LLM usage event');
    });
  }

  /** Record estimated billing for a failed (timeout / server-error) LLM call. Fire-and-forget. */
  recordFailedLlmCall(input: {
    provider: string;
    model: string;
    maxTokens: number;
    phase: string;
    turnIndex?: number;
    attemptIndex?: number;
  }): void {
    if (!this.config.enabled) return;

    void this.doRecordFailedLlmCall(input).catch((err: unknown) => {
      logger.warn({ err, phase: input.phase }, 'Failed to record failed LLM call billing event');
    });
  }

  private async doRecordFailedLlmCall(input: {
    provider: string;
    model: string;
    maxTokens: number;
    phase: string;
    turnIndex?: number;
    attemptIndex?: number;
  }): Promise<void> {
    const failedRequestOutputPct = this.config.failedRequestOutputPct ?? 75;
    const estimatedOutputTokens = Math.round(input.maxTokens * failedRequestOutputPct / 100);
    if (estimatedOutputTokens <= 0) return;

    const now = new Date();
    const ok = await this.ensureAccount(now);
    if (!ok || !this.accountId) return;

    const idScope = [
      this.config.sessionId,
      input.phase,
      `t${input.turnIndex ?? 0}`,
      `a${input.attemptIndex ?? 0}`,
      input.provider,
      input.model,
      'failed',
    ].join('_');

    const event = {
      id: `ue_${crypto.randomUUID().replace(/-/g, '')}`,
      accountId: this.accountId,
      userId: this.config.userId,
      agentId: this.config.agentId,
      sessionId: this.config.sessionId,
      skillId: this.config.skillId ?? null,
      sourceType: 'llm_call',
      meterKey: 'llm.output_tokens' as const,
      provider: input.provider,
      model: input.model,
      quantity: estimatedOutputTokens,
      unit: 'tokens',
      idempotencyKey: `llm_fail_out_${idScope}`,
      occurredAt: now,
      metadata: { estimated: true, basis: 'failed_request_fraction' },
    };

    if (this.periodId && this.rateCardId) {
      const items = await this.repo.getRateCardItems(this.rateCardId);
      await this.repo.recordAndRateUsageBatch([event], this.periodId, this.accountId, items);
    } else {
      await this.repo.recordUsageEvents([event]);
    }
  }

  private async doRecordLlmUsage(input: LlmUsageInput): Promise<void> {
    const now = new Date();
    const ok = await this.ensureAccount(now);
    if (!ok || !this.accountId) return;

    const events = [];
    const idScope = [
      this.config.sessionId,
      input.phase,
      `t${input.turnIndex ?? 0}`,
      input.provider,
      input.model,
      input.responseId ?? 'no_response_id',
    ].join('_');

    const cachedTokens = input.cachedInputTokens ?? 0;
    // inputTokens is already normalised to non-cached by the provider layer
    // (llm-provider.ts subtracts cached_tokens from prompt_tokens for the
    // OpenAI-compatible path; Anthropic already separates them).
    const nonCachedInputTokens = input.inputTokens ?? null;

    if (nonCachedInputTokens != null && nonCachedInputTokens > 0) {
      events.push({
        id: `ue_${crypto.randomUUID().replace(/-/g, '')}`,
        accountId: this.accountId,
        userId: this.config.userId,
        agentId: this.config.agentId,
        sessionId: this.config.sessionId,
        skillId: this.config.skillId ?? null,
        sourceType: 'llm_call',
        meterKey: 'llm.input_tokens',
        provider: input.provider,
        model: input.model,
        quantity: nonCachedInputTokens,
        unit: 'tokens',
        idempotencyKey: `llm_in_${idScope}`,
        occurredAt: now,
      });
    }

    if (cachedTokens > 0) {
      events.push({
        id: `ue_${crypto.randomUUID().replace(/-/g, '')}`,
        accountId: this.accountId,
        userId: this.config.userId,
        agentId: this.config.agentId,
        sessionId: this.config.sessionId,
        skillId: this.config.skillId ?? null,
        sourceType: 'llm_call',
        meterKey: 'llm.cached_input_tokens',
        provider: input.provider,
        model: input.model,
        quantity: cachedTokens,
        unit: 'tokens',
        idempotencyKey: `llm_cached_${idScope}`,
        occurredAt: now,
      });
    }

    if (input.outputTokens != null && input.outputTokens > 0) {
      events.push({
        id: `ue_${crypto.randomUUID().replace(/-/g, '')}`,
        accountId: this.accountId,
        userId: this.config.userId,
        agentId: this.config.agentId,
        sessionId: this.config.sessionId,
        skillId: this.config.skillId ?? null,
        sourceType: 'llm_call',
        meterKey: 'llm.output_tokens',
        provider: input.provider,
        model: input.model,
        quantity: input.outputTokens,
        unit: 'tokens',
        idempotencyKey: `llm_out_${idScope}`,
        occurredAt: now,
      });
    }

    if (input.thinkingTokens != null && input.thinkingTokens > 0) {
      events.push({
        id: `ue_${crypto.randomUUID().replace(/-/g, '')}`,
        accountId: this.accountId,
        userId: this.config.userId,
        agentId: this.config.agentId,
        sessionId: this.config.sessionId,
        skillId: this.config.skillId ?? null,
        sourceType: 'llm_call',
        meterKey: 'llm.reasoning_tokens',
        provider: input.provider,
        model: input.model,
        quantity: input.thinkingTokens,
        unit: 'tokens',
        idempotencyKey: `llm_think_${idScope}`,
        occurredAt: now,
      });
    }

    // Fallback: provider only exposes total — record as output_tokens with metadata
    if (events.length === 0 && input.tokensUsed != null && input.tokensUsed > 0) {
      events.push({
        id: `ue_${crypto.randomUUID().replace(/-/g, '')}`,
        accountId: this.accountId,
        userId: this.config.userId,
        agentId: this.config.agentId,
        sessionId: this.config.sessionId,
        skillId: this.config.skillId ?? null,
        sourceType: 'llm_call',
        meterKey: 'llm.output_tokens',
        provider: input.provider,
        model: input.model,
        quantity: input.tokensUsed,
        unit: 'tokens',
        idempotencyKey: `llm_total_${idScope}`,
        occurredAt: now,
        metadata: { granularity: 'total_only' },
      });
    }

    if (events.length === 0) return;

    if (this.periodId && this.rateCardId) {
      const items = await this.repo.getRateCardItems(this.rateCardId);
      await this.repo.recordAndRateUsageBatch(events, this.periodId, this.accountId, items);
    } else {
      await this.repo.recordUsageEvents(events);
    }
  }

  /**
   * Flush a coarse runtime window event. Call on each heartbeat tick.
   * Only flushes when a full window has elapsed.
   */
  flushRuntimeWindow(force = false): void {
    if (!this.config.enabled) return;

    const now = Date.now();
    const elapsed = now - this.runtimeWindowStartAt;

    if (!force && elapsed < this.config.runtimeChargeWindowMs) return;

    if (elapsed <= 0) return;

    const windowMs = force ? elapsed : this.config.runtimeChargeWindowMs;
    const windowStartAt = this.runtimeWindowStartAt;
    const windowEndAt = windowStartAt + windowMs;
    this.runtimeWindowStartAt = windowEndAt;

    void this.doRecordRuntimeWindow(windowMs, new Date(windowEndAt), windowStartAt, windowEndAt).catch((err: unknown) => {
      logger.warn({ err }, 'Failed to record runtime window event');
    });
  }

  /** Record a browser session usage event. Fire-and-forget. */
  recordBrowserSession(input: { durationMs: number; browserSessionId: string }): void {
    if (!this.config.enabled) return;
    if (input.durationMs <= 0) return;

    void this.doRecordBrowserSession(input).catch((err: unknown) => {
      logger.warn({ err, durationMs: input.durationMs }, 'Failed to record browser session usage event');
    });
  }

  private async doRecordBrowserSession(input: { durationMs: number; browserSessionId: string }): Promise<void> {
    const now = new Date();
    const ok = await this.ensureAccount(now);
    if (!ok || !this.accountId) return;

    const event = {
      id: `ue_${crypto.randomUUID().replace(/-/g, '')}`,
      accountId: this.accountId,
      userId: this.config.userId,
      agentId: this.config.agentId,
      sessionId: this.config.sessionId,
      skillId: this.config.skillId ?? null,
      sourceType: 'browser_session',
      meterKey: 'browser.session_ms',
      provider: null as string | null,
      model: null as string | null,
      quantity: input.durationMs,
      unit: 'milliseconds',
      idempotencyKey: `browser_${this.config.sessionId}_${input.browserSessionId}`,
      occurredAt: now,
      metadata: { browserSessionId: input.browserSessionId },
    };

    if (this.periodId && this.rateCardId) {
      const items = await this.repo.getRateCardItems(this.rateCardId);
      await this.repo.recordAndRateUsageBatch([event], this.periodId, this.accountId, items);
    } else {
      await this.repo.recordUsageEvents([event]);
    }
  }

  /** Close the final partial runtime window on session stop. */
  closeRuntimeWindow(): void {
    this.flushRuntimeWindow(true);
  }

  private async doRecordRuntimeWindow(windowMs: number, occurredAt: Date, windowStartAt: number, windowEndAt: number): Promise<void> {
    const ok = await this.ensureAccount(occurredAt);
    if (!ok || !this.accountId) return;

    const event = {
      id: `ue_${crypto.randomUUID().replace(/-/g, '')}`,
      accountId: this.accountId,
      userId: this.config.userId,
      agentId: this.config.agentId,
      sessionId: this.config.sessionId,
      skillId: this.config.skillId ?? null,
      sourceType: 'agent_runtime',
      meterKey: 'agent.runtime_ms',
      provider: null as string | null,
      model: null as string | null,
      quantity: windowMs,
      unit: 'milliseconds',
      idempotencyKey: `rt_${this.config.sessionId}_${windowStartAt}_${windowEndAt}`,
      occurredAt,
      metadata: { windowStartAt, windowEndAt },
    };

    if (this.periodId && this.rateCardId) {
      const items = await this.repo.getRateCardItems(this.rateCardId);
      await this.repo.recordAndRateUsageBatch([event], this.periodId, this.accountId, items);
    } else {
      await this.repo.recordUsageEvents([event]);
    }
  }
}

export function createUsageBillingService(
  db: Database | null,
  config: Omit<UsageBillingServiceConfig, 'enabled'> & { enabled?: boolean },
): UsageBillingService | null {
  if (!db) return null;
  if (!config.userId) return null;

  return new UsageBillingService(db, {
    ...config,
    enabled: config.enabled ?? false,
  });
}
