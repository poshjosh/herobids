import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatUsageBillingRecorder, type AggregateChatLlmUsage } from './chat-usage-billing-recorder.js';
import type { PlansConfig } from '@herobids/domain';
import type { InsertUsageEvent } from '@herobids/db';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_PLANS: PlansConfig = {
  defaultPlanId: 'free',
  plans: {
    free: {
      entitlements: {},
      usage: { includedCreditCents: 0, softCapCents: 0, hardCapCents: 100, topUpPackIds: [] },
    },
    starter: {
      entitlements: {},
      usage: { includedCreditCents: 2000, softCapCents: 0, hardCapCents: 200, topUpPackIds: ['Topup5'] },
    },
  },
};

function makeTestUsage(): AggregateChatLlmUsage {
  return {
    provider: 'openai',
    model: 'gpt-4o',
    inputTokens: 500,
    outputTokens: 200,
    thinkingTokens: 0,
    cachedInputTokens: 50,
    tokensUsed: 750,
  };
}

function makeRecorder(repoOverrides: Record<string, unknown> = {}) {
  const mockRepo = {
    getUserPlanId: vi.fn().mockResolvedValue('free'),
    getOrCreateBillingAccountForUser: vi.fn().mockResolvedValue({
      id: 'acct-1',
      activePlanId: 'free',
      softCapMicrousd: null,
      hardCapMicrousd: 10_000_000,
    }),
    ensureActiveRateCard: vi.fn().mockResolvedValue({ id: 'rc-1' }),
    getOrCreateOpenPeriod: vi.fn().mockResolvedValue({ id: 'period-1' }),
    getRateCardItems: vi.fn().mockResolvedValue([]),
    recordAndRateUsageBatch: vi.fn().mockResolvedValue({ totalChargeMicrousd: 0, status: 'active' }),
    ...repoOverrides,
  } as any;

  const recorder = new ChatUsageBillingRecorder(mockRepo, TEST_PLANS, 'default');
  return { recorder, mockRepo };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChatUsageBillingRecorder', () => {
  let usage: AggregateChatLlmUsage;

  beforeEach(() => {
    usage = makeTestUsage();
  });

  // -----------------------------------------------------------------------
  // 1. Fresh user with no billing account
  // -----------------------------------------------------------------------

  it('creates a billing account lazily when none exists for the user', async () => {
    const { recorder, mockRepo } = makeRecorder();
    (mockRepo.getUserPlanId as ReturnType<typeof vi.fn>).mockResolvedValue(null); // no plan → falls back to 'free'

    await recorder.record({
      userId: 'user-1',
      threadId: 'thread-1',
      billingAnchorId: 'msg-1',
      phase: 'message_send',
      usage,
    });

    expect(mockRepo.getOrCreateBillingAccountForUser).toHaveBeenCalledWith(
      'user-1',
      'free',
      { softCapMicrousd: 0, hardCapMicrousd: 1_000_000 },
    );
  });

  // -----------------------------------------------------------------------
  // 2. Included credit is resolved from plan config
  // -----------------------------------------------------------------------

  it('resolves included credit from plan config not from account row', async () => {
    const { recorder, mockRepo } = makeRecorder();
    (mockRepo.getUserPlanId as ReturnType<typeof vi.fn>).mockResolvedValue('starter');

    // Account row has no included credit field (that's the design).
    // The recorder reads includedCredit from plan config and passes it to getOrCreateOpenPeriod.
    await recorder.record({
      userId: 'user-2',
      threadId: 'thread-1',
      billingAnchorId: 'msg-1',
      phase: 'message_send',
      usage,
    });

    // starter plan has includedCreditCents: 2000 → 20,000,000 microusd
    const getOrCreateCall = (mockRepo.getOrCreateOpenPeriod as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    const includedCreditArg = getOrCreateCall[4] as number;
    expect(includedCreditArg).toBe(20_000_000);
  });

  it('falls back to free plan usage when plan config is missing', async () => {
    const { recorder, mockRepo } = makeRecorder();
    (mockRepo.getUserPlanId as ReturnType<typeof vi.fn>).mockResolvedValue('nonexistent');

    await recorder.record({
      userId: 'user-3',
      threadId: 'thread-1',
      billingAnchorId: 'msg-1',
      phase: 'message_send',
      usage,
    });

    const getOrCreateCall = (mockRepo.getOrCreateOpenPeriod as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    const includedCreditArg = getOrCreateCall[4] as number;
    expect(includedCreditArg).toBe(0); // free plan: 0 cents → 0 microusd
  });

  // -----------------------------------------------------------------------
  // 3. ensureActiveRateCard is called with the defaultRateCardName
  // -----------------------------------------------------------------------

  it('calls ensureActiveRateCard with the configured rate card name', async () => {
    const { recorder, mockRepo } = makeRecorder();

    await recorder.record({
      userId: 'user-1',
      threadId: 'thread-1',
      billingAnchorId: 'msg-1',
      phase: 'message_send',
      usage,
    });

    expect(mockRepo.ensureActiveRateCard).toHaveBeenCalledWith('default');
    expect(mockRepo.getRateCardItems).toHaveBeenCalledWith('rc-1');
  });

  // -----------------------------------------------------------------------
  // 4. recordAndRateUsageBatch is called with expected meter keys and quantities
  // -----------------------------------------------------------------------

  it('calls recordAndRateUsageBatch with expected meter keys and quantities', async () => {
    const { recorder, mockRepo } = makeRecorder();

    await recorder.record({
      userId: 'user-1',
      threadId: 'thread-1',
      billingAnchorId: 'msg-2',
      phase: 'action_result',
      usage: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        inputTokens: 1000,
        outputTokens: 300,
        thinkingTokens: 0,
        cachedInputTokens: 0,
        tokensUsed: 1300,
      },
    });

    const events = (mockRepo.recordAndRateUsageBatch as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as InsertUsageEvent[];

    // input_tokens and output_tokens expected
    const meterKeys = events.map((e: InsertUsageEvent) => e.meterKey).sort();
    expect(meterKeys).toEqual(['llm.input_tokens', 'llm.output_tokens']);

    const inputEvent = events.find((e: InsertUsageEvent) => e.meterKey === 'llm.input_tokens')!;
    expect(inputEvent.quantity).toBe(1000);
    expect(inputEvent.provider).toBe('anthropic');
    expect(inputEvent.model).toBe('claude-sonnet-4-20250514');
    expect(inputEvent.sourceType).toBe('chat_llm');

    const outputEvent = events.find((e: InsertUsageEvent) => e.meterKey === 'llm.output_tokens')!;
    expect(outputEvent.quantity).toBe(300);

    // Verify recordAndRateUsageBatch called with period, account, items
    expect(mockRepo.recordAndRateUsageBatch).toHaveBeenCalledWith(
      events,
      'period-1',
      'acct-1',
      [],
    );
  });

  // -----------------------------------------------------------------------
  // 5. llm.reasoning_tokens is recorded when thinkingTokens > 0
  // -----------------------------------------------------------------------

  it('records llm.reasoning_tokens when thinkingTokens > 0', async () => {
    const { recorder, mockRepo } = makeRecorder();

    await recorder.record({
      userId: 'user-1',
      threadId: 'thread-1',
      billingAnchorId: 'msg-3',
      phase: 'message_send',
      usage: {
        provider: 'openai',
        model: 'o3',
        inputTokens: 200,
        outputTokens: 100,
        thinkingTokens: 500,
        cachedInputTokens: 0,
        tokensUsed: 800,
      },
    });

    const events = (mockRepo.recordAndRateUsageBatch as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as InsertUsageEvent[];

    const reasoningEvent = events.find((e: InsertUsageEvent) => e.meterKey === 'llm.reasoning_tokens');
    expect(reasoningEvent).toBeDefined();
    expect(reasoningEvent!.quantity).toBe(500);
  });

  // -----------------------------------------------------------------------
  // 6. tokensUsed fallback when granular fields are unavailable
  // -----------------------------------------------------------------------

  it('falls back to single llm.output_tokens event with total_only granularity', async () => {
    const { recorder, mockRepo } = makeRecorder();

    await recorder.record({
      userId: 'user-1',
      threadId: 'thread-1',
      billingAnchorId: 'msg-4',
      phase: 'action_result',
      usage: {
        provider: 'google',
        model: 'gemini-2.5-pro',
        inputTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        cachedInputTokens: 0,
        tokensUsed: 420,
      },
    });

    const events = (mockRepo.recordAndRateUsageBatch as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as InsertUsageEvent[];

    expect(events).toHaveLength(1);
    expect(events[0]!.meterKey).toBe('llm.output_tokens');
    expect(events[0]!.quantity).toBe(420);
    expect(events[0]!.metadata).toEqual({ granularity: 'total_only' });
  });

  // -----------------------------------------------------------------------
  // 7. Idempotency keys are derived from phase + billingAnchorId
  // -----------------------------------------------------------------------

  it('derives idempotency keys from phase and billingAnchorId', async () => {
    const { recorder, mockRepo } = makeRecorder();

    await recorder.record({
      userId: 'user-1',
      threadId: 'thread-1',
      billingAnchorId: 'anchor-xyz',
      phase: 'message_send',
      usage,
    });

    const events = (mockRepo.recordAndRateUsageBatch as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as InsertUsageEvent[];

    for (const event of events) {
      expect(event.idempotencyKey).toMatch(/chat_llm_(in|out|cached)_message_send_anchor-xyz/);
    }
  });

  it('uses different idempotency keys for different phases', async () => {
    const { recorder, mockRepo } = makeRecorder();

    await recorder.record({
      userId: 'user-1',
      threadId: 'thread-1',
      billingAnchorId: 'anchor-1',
      phase: 'message_send',
      usage,
    });

    await recorder.record({
      userId: 'user-1',
      threadId: 'thread-1',
      billingAnchorId: 'anchor-2',
      phase: 'action_result',
      usage,
    });

    const calls = (mockRepo.recordAndRateUsageBatch as ReturnType<typeof vi.fn>).mock.calls;
    const sendEvents = calls[0]![0] as InsertUsageEvent[];
    const actionEvents = calls[1]![0] as InsertUsageEvent[];

    const sendKey = sendEvents[0]!.idempotencyKey;
    const actionKey = actionEvents[0]!.idempotencyKey;
    expect(sendKey).toContain('message_send_anchor-1');
    expect(actionKey).toContain('action_result_anchor-2');
    expect(sendKey).not.toBe(actionKey);
  });

  // -----------------------------------------------------------------------
  // Edge: zero tokens produces no events and no batch call
  // -----------------------------------------------------------------------

  it('produces no events when all token fields are zero', async () => {
    const { recorder, mockRepo } = makeRecorder();

    await recorder.record({
      userId: 'user-1',
      threadId: 'thread-1',
      billingAnchorId: 'msg-zero',
      phase: 'message_send',
      usage: {
        provider: 'openai',
        model: 'gpt-4o',
        inputTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        cachedInputTokens: 0,
        tokensUsed: 0,
      },
    });

    // The events array will be empty, so recordAndRateUsageBatch returns
    // early with { totalChargeMicrousd: 0, status: 'active' }.
    expect(mockRepo.recordAndRateUsageBatch).toHaveBeenCalledWith([], 'period-1', 'acct-1', []);
  });

  // -----------------------------------------------------------------------
  // Edge: cached input tokens are recorded separately
  // -----------------------------------------------------------------------

  it('records llm.cached_input_tokens when cachedInputTokens > 0', async () => {
    const { recorder, mockRepo } = makeRecorder();

    await recorder.record({
      userId: 'user-1',
      threadId: 'thread-1',
      billingAnchorId: 'msg-cached',
      phase: 'message_send',
      usage: {
        provider: 'openai',
        model: 'gpt-4o',
        inputTokens: 100,
        outputTokens: 50,
        thinkingTokens: 0,
        cachedInputTokens: 200,
        tokensUsed: 350,
      },
    });

    const events = (mockRepo.recordAndRateUsageBatch as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as InsertUsageEvent[];

    const cachedEvent = events.find((e: InsertUsageEvent) => e.meterKey === 'llm.cached_input_tokens');
    expect(cachedEvent).toBeDefined();
    expect(cachedEvent!.quantity).toBe(200);
    expect(cachedEvent!.idempotencyKey).toBe('chat_llm_cached_message_send_msg-cached');
  });
});
