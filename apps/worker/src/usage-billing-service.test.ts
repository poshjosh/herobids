import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsageBillingRepository } from '@herobids/db';
import type { BillingAccountRow } from '@herobids/db';
import { UsageBillingService } from './usage-billing-service.js';

function makeAccount(): BillingAccountRow {
  return {
    id: 'acc_user_1',
    ownerUserId: 'user-1',
    status: 'active',
    currency: 'USD',
    activePlanId: 'pro',
    softCapMicrousd: null,
    hardCapMicrousd: null,
    lastEvaluatedAt: null,
    createdAt: new Date('2026-01-31T23:59:00.000Z'),
    updatedAt: new Date('2026-01-31T23:59:00.000Z'),
  };
}

function createService(): UsageBillingService {
  return new UsageBillingService({} as import('@herobids/db').Database, {
    userId: 'user-1',
    agentId: 'agent-1',
    sessionId: 'session-1',
    defaultRateCardName: 'default',
    runtimeChargeWindowMs: 60_000,
    enabled: true,
    planId: 'pro',
    includedCreditMicrousd: 2_500_000,
  });
}

describe('UsageBillingService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('retries account resolution after a transient bootstrap failure', async () => {
    const account = makeAccount();

    const getOrCreateSpy = vi.spyOn(UsageBillingRepository.prototype, 'getOrCreateBillingAccountForUser')
      .mockRejectedValueOnce(new Error('temporary database outage'))
      .mockResolvedValue(account);
    vi.spyOn(UsageBillingRepository.prototype, 'ensureActiveRateCard').mockResolvedValue({ id: 'rc_default_v1' });
    vi.spyOn(UsageBillingRepository.prototype, 'getAccountByUserId').mockResolvedValue(account);
    vi.spyOn(UsageBillingRepository.prototype, 'getOrCreateOpenPeriod').mockResolvedValue({ id: 'period_1' } as never);
    vi.spyOn(UsageBillingRepository.prototype, 'getSpendState').mockResolvedValue({ status: 'hard_limited' });

    const service = createService();

    await expect(service.isHardLimited()).resolves.toBe(false);
    await expect(service.isHardLimited()).resolves.toBe(true);
    expect(getOrCreateSpy).toHaveBeenCalledTimes(2);
  });

  it('reopens the billing period when a long-lived session crosses a month boundary', async () => {
    vi.useFakeTimers();
    const account = makeAccount();
    const openPeriodSpy = vi.spyOn(UsageBillingRepository.prototype, 'getOrCreateOpenPeriod')
      .mockResolvedValueOnce({ id: 'period_2026_01' } as never)
      .mockResolvedValueOnce({ id: 'period_2026_02' } as never);

    vi.spyOn(UsageBillingRepository.prototype, 'getOrCreateBillingAccountForUser').mockResolvedValue(account);
    vi.spyOn(UsageBillingRepository.prototype, 'ensureActiveRateCard').mockResolvedValue({ id: 'rc_default_v1' });
    vi.spyOn(UsageBillingRepository.prototype, 'getAccountByUserId').mockResolvedValue(account);
    vi.spyOn(UsageBillingRepository.prototype, 'getSpendState').mockResolvedValue({ status: 'active' });

    const service = createService();

    vi.setSystemTime(new Date('2026-01-31T23:59:00.000Z'));
    await expect(service.isHardLimited()).resolves.toBe(false);

    vi.setSystemTime(new Date('2026-02-01T00:01:00.000Z'));
    await expect(service.isHardLimited()).resolves.toBe(false);

    expect(openPeriodSpy).toHaveBeenCalledTimes(2);
    expect(openPeriodSpy.mock.calls[1]?.[1]).toBeInstanceOf(Date);
    expect((openPeriodSpy.mock.calls[1]?.[1] as Date).toISOString()).toContain('2026-02');
  });

  // ── Billing enforcement: observation-only warnings ─────────────────────
  // Soft cap must not change agent behavior — it only emits a warning event.
  // These tests verify the service-level spend-state checks that the runtime
  // uses to decide whether to emit a warning or stop the tick.

  it('returns isSoftLimited=true when account spend state is soft_limited', async () => {
    const account = makeAccount();
    vi.spyOn(UsageBillingRepository.prototype, 'getOrCreateBillingAccountForUser').mockResolvedValue(account);
    vi.spyOn(UsageBillingRepository.prototype, 'ensureActiveRateCard').mockResolvedValue({ id: 'rc_default_v1' });
    vi.spyOn(UsageBillingRepository.prototype, 'getAccountByUserId').mockResolvedValue(account);
    vi.spyOn(UsageBillingRepository.prototype, 'getOrCreateOpenPeriod').mockResolvedValue({ id: 'period_1' } as never);
    vi.spyOn(UsageBillingRepository.prototype, 'getSpendState').mockResolvedValue({ status: 'soft_limited' });

    const service = createService();
    await expect(service.isSoftLimited()).resolves.toBe(true);
    // Soft-limited accounts are NOT hard-limited — the tick still runs.
    await expect(service.isHardLimited()).resolves.toBe(false);
  });

  it('returns isSoftLimited=false when account spend state is active', async () => {
    const account = makeAccount();
    vi.spyOn(UsageBillingRepository.prototype, 'getOrCreateBillingAccountForUser').mockResolvedValue(account);
    vi.spyOn(UsageBillingRepository.prototype, 'ensureActiveRateCard').mockResolvedValue({ id: 'rc_default_v1' });
    vi.spyOn(UsageBillingRepository.prototype, 'getAccountByUserId').mockResolvedValue(account);
    vi.spyOn(UsageBillingRepository.prototype, 'getOrCreateOpenPeriod').mockResolvedValue({ id: 'period_1' } as never);
    vi.spyOn(UsageBillingRepository.prototype, 'getSpendState').mockResolvedValue({ status: 'active' });

    const service = createService();
    await expect(service.isSoftLimited()).resolves.toBe(false);
    await expect(service.isHardLimited()).resolves.toBe(false);
  });

  it('returns isHardLimited=true for both hard_limited and suspended statuses', async () => {
    const account = makeAccount();
    vi.spyOn(UsageBillingRepository.prototype, 'getOrCreateBillingAccountForUser').mockResolvedValue(account);
    vi.spyOn(UsageBillingRepository.prototype, 'ensureActiveRateCard').mockResolvedValue({ id: 'rc_default_v1' });
    vi.spyOn(UsageBillingRepository.prototype, 'getAccountByUserId').mockResolvedValue(account);
    vi.spyOn(UsageBillingRepository.prototype, 'getOrCreateOpenPeriod').mockResolvedValue({ id: 'period_1' } as never);

    vi.spyOn(UsageBillingRepository.prototype, 'getSpendState').mockResolvedValue({ status: 'hard_limited' });
    await expect(createService().isHardLimited()).resolves.toBe(true);

    vi.spyOn(UsageBillingRepository.prototype, 'getSpendState').mockResolvedValue({ status: 'suspended' });
    await expect(createService().isHardLimited()).resolves.toBe(true);
  });

  it('returns false for both checks when billing is not enabled', async () => {
    const service = new UsageBillingService({} as import('@herobids/db').Database, {
      userId: 'user-1',
      agentId: 'agent-1',
      sessionId: 'session-1',
      defaultRateCardName: 'default',
      runtimeChargeWindowMs: 60_000,
      enabled: false,
    });

    await expect(service.isSoftLimited()).resolves.toBe(false);
    await expect(service.isHardLimited()).resolves.toBe(false);
  });

  it('accepts providersYaml in config, enabling per-model rate card seeding at the repository layer', async () => {
    const account = makeAccount();
    const mockProviders: import('@herobids/domain').ProvidersYaml = {
      providers: {
        openai: { catalogMode: 'static', models: { 'gpt-4o': { inputUsdPerM: 2.5, outputUsdPerM: 10 } } },
      },
    };

    vi.spyOn(UsageBillingRepository.prototype, 'getOrCreateBillingAccountForUser').mockResolvedValue(account);
    vi.spyOn(UsageBillingRepository.prototype, 'ensureActiveRateCard').mockResolvedValue({ id: 'rc_default_v1' });
    vi.spyOn(UsageBillingRepository.prototype, 'getAccountByUserId').mockResolvedValue(account);
    vi.spyOn(UsageBillingRepository.prototype, 'getOrCreateOpenPeriod').mockResolvedValue({ id: 'period_1' } as never);
    vi.spyOn(UsageBillingRepository.prototype, 'getSpendState').mockResolvedValue({ status: 'active' });

    const service = new UsageBillingService({} as import('@herobids/db').Database, {
      userId: 'user-1',
      agentId: 'agent-1',
      sessionId: 'session-1',
      defaultRateCardName: 'default',
      runtimeChargeWindowMs: 60_000,
      enabled: true,
      providersYaml: mockProviders,
    });

    // providersYaml is accepted by the constructor and passed through to
    // UsageBillingRepository — the repo-level test in
    // packages/db/src/usage-billing-repository.test.ts verifies that
    // seedDefaultRateCardItems calls getLatestPricingSnapshot when
    // providers are configured.
    await expect(service.isHardLimited()).resolves.toBe(false);
    expect(service).toBeDefined();
  });

  // ── isHardLimited backward compat: only checks account status, not available credit ──

  it('isHardLimited returns false when account is active even if canSpendNow would block on no_available_credit', async () => {
    const account = makeAccount();
    vi.spyOn(UsageBillingRepository.prototype, 'getOrCreateBillingAccountForUser').mockResolvedValue(account);
    vi.spyOn(UsageBillingRepository.prototype, 'ensureActiveRateCard').mockResolvedValue({ id: 'rc_default_v1' });
    vi.spyOn(UsageBillingRepository.prototype, 'getAccountByUserId').mockResolvedValue(account);
    vi.spyOn(UsageBillingRepository.prototype, 'getOrCreateOpenPeriod').mockResolvedValue({ id: 'period_1' } as never);
    // Account status is active — isHardLimited should return false regardless of credit
    vi.spyOn(UsageBillingRepository.prototype, 'getSpendState').mockResolvedValue({ status: 'active' });

    const service = createService();
    await expect(service.isHardLimited()).resolves.toBe(false);
  });

  // ── canSpendNow: zero-balance enforcement ─────────────────────────────────

  it('canSpendNow returns canSpend: false when repo reports no_available_credit', async () => {
    const account = makeAccount();
    vi.spyOn(UsageBillingRepository.prototype, 'getOrCreateBillingAccountForUser').mockResolvedValue(account);
    vi.spyOn(UsageBillingRepository.prototype, 'ensureActiveRateCard').mockResolvedValue({ id: 'rc_default_v1' });
    vi.spyOn(UsageBillingRepository.prototype, 'getAccountByUserId').mockResolvedValue(account);
    vi.spyOn(UsageBillingRepository.prototype, 'getOrCreateOpenPeriod').mockResolvedValue({ id: 'period_1' } as never);
    const canSpendNowSpy = vi.spyOn(UsageBillingRepository.prototype, 'canSpendNow').mockResolvedValue({
      canSpend: false,
      availableMicrousd: -100,
      hardCapMicrousd: null,
      status: 'active',
      reason: 'no_available_credit',
    });

    const service = createService();
    const result = await service.canSpendNow();
    expect(canSpendNowSpy).toHaveBeenCalledWith('acc_user_1');
    expect(result).toEqual({
      canSpend: false,
      availableMicrousd: -100,
      hardCapMicrousd: null,
      status: 'active',
      reason: 'no_available_credit',
    });
  });

  it('canSpendNow returns canSpend: true when repo reports ok', async () => {
    const account = makeAccount();
    vi.spyOn(UsageBillingRepository.prototype, 'getOrCreateBillingAccountForUser').mockResolvedValue(account);
    vi.spyOn(UsageBillingRepository.prototype, 'ensureActiveRateCard').mockResolvedValue({ id: 'rc_default_v1' });
    vi.spyOn(UsageBillingRepository.prototype, 'getAccountByUserId').mockResolvedValue(account);
    vi.spyOn(UsageBillingRepository.prototype, 'getOrCreateOpenPeriod').mockResolvedValue({ id: 'period_1' } as never);
    const canSpendNowSpy = vi.spyOn(UsageBillingRepository.prototype, 'canSpendNow').mockResolvedValue({
      canSpend: true,
      availableMicrousd: 5000,
      hardCapMicrousd: null,
      status: 'active',
      reason: 'ok',
    });

    const service = createService();
    const result = await service.canSpendNow();
    expect(canSpendNowSpy).toHaveBeenCalledWith('acc_user_1');
    expect(result).toEqual({
      canSpend: true,
      availableMicrousd: 5000,
      hardCapMicrousd: null,
      status: 'active',
      reason: 'ok',
    });
  });

  it('canSpendNow fails open when billing is disabled', async () => {
    const service = new UsageBillingService({} as import('@herobids/db').Database, {
      userId: 'user-1',
      agentId: 'agent-1',
      sessionId: 'session-1',
      defaultRateCardName: 'default',
      runtimeChargeWindowMs: 60_000,
      enabled: false,
    });

    const result = await service.canSpendNow();
    expect(result).toEqual({
      canSpend: true,
      availableMicrousd: 0,
      hardCapMicrousd: null,
      status: 'active',
      reason: 'ok',
    });
  });

  it('canSpendNow fails open when account resolution fails', async () => {
    vi.spyOn(UsageBillingRepository.prototype, 'getOrCreateBillingAccountForUser')
      .mockRejectedValue(new Error('database unavailable'));

    const service = createService();
    const result = await service.canSpendNow();
    expect(result).toEqual({
      canSpend: true,
      availableMicrousd: 0,
      hardCapMicrousd: null,
      status: 'active',
      reason: 'ok',
    });
  });

  it('canSpendNow fails open when repo.canSpendNow throws after successful account resolution', async () => {
    const account = makeAccount();
    vi.spyOn(UsageBillingRepository.prototype, 'getOrCreateBillingAccountForUser').mockResolvedValue(account);
    vi.spyOn(UsageBillingRepository.prototype, 'ensureActiveRateCard').mockResolvedValue({ id: 'rc_default_v1' });
    vi.spyOn(UsageBillingRepository.prototype, 'getAccountByUserId').mockResolvedValue(account);
    vi.spyOn(UsageBillingRepository.prototype, 'getOrCreateOpenPeriod').mockResolvedValue({ id: 'period_1' } as never);
    // ensureAccount succeeds, but the actual repo call throws
    vi.spyOn(UsageBillingRepository.prototype, 'canSpendNow').mockRejectedValue(new Error('DB connection lost'));

    const service = createService();
    const result = await service.canSpendNow();
    expect(result).toEqual({
      canSpend: true,
      availableMicrousd: 0,
      hardCapMicrousd: null,
      status: 'active',
      reason: 'ok',
    });
  });

  it('canSpendNow returns hard_limited reason when repo reports hard_limited', async () => {
    const account = makeAccount();
    vi.spyOn(UsageBillingRepository.prototype, 'getOrCreateBillingAccountForUser').mockResolvedValue(account);
    vi.spyOn(UsageBillingRepository.prototype, 'ensureActiveRateCard').mockResolvedValue({ id: 'rc_default_v1' });
    vi.spyOn(UsageBillingRepository.prototype, 'getAccountByUserId').mockResolvedValue(account);
    vi.spyOn(UsageBillingRepository.prototype, 'getOrCreateOpenPeriod').mockResolvedValue({ id: 'period_1' } as never);
    const canSpendNowSpy = vi.spyOn(UsageBillingRepository.prototype, 'canSpendNow').mockResolvedValue({
      canSpend: false,
      availableMicrousd: 0,
      hardCapMicrousd: null,
      status: 'hard_limited',
      reason: 'hard_limited',
    });

    const service = createService();
    const result = await service.canSpendNow();
    expect(canSpendNowSpy).toHaveBeenCalledWith('acc_user_1');
    expect(result.canSpend).toBe(false);
    expect(result.reason).toBe('hard_limited');
    expect(result.status).toBe('hard_limited');
  });

  it('canSpendNow returns suspended reason when repo reports suspended', async () => {
    const account = makeAccount();
    vi.spyOn(UsageBillingRepository.prototype, 'getOrCreateBillingAccountForUser').mockResolvedValue(account);
    vi.spyOn(UsageBillingRepository.prototype, 'ensureActiveRateCard').mockResolvedValue({ id: 'rc_default_v1' });
    vi.spyOn(UsageBillingRepository.prototype, 'getAccountByUserId').mockResolvedValue(account);
    vi.spyOn(UsageBillingRepository.prototype, 'getOrCreateOpenPeriod').mockResolvedValue({ id: 'period_1' } as never);
    const canSpendNowSpy = vi.spyOn(UsageBillingRepository.prototype, 'canSpendNow').mockResolvedValue({
      canSpend: false,
      availableMicrousd: 0,
      hardCapMicrousd: null,
      status: 'suspended',
      reason: 'suspended',
    });

    const service = createService();
    const result = await service.canSpendNow();
    expect(canSpendNowSpy).toHaveBeenCalledWith('acc_user_1');
    expect(result.canSpend).toBe(false);
    expect(result.reason).toBe('suspended');
    expect(result.status).toBe('suspended');
  });

  // ── LLM usage event splitting: cached vs non-cached tokens ───────────────
  // These tests lock in the recording semantics introduced with cached-token
  // billing.  inputTokens is always the non-cached count (normalised in
  // llm-provider.ts); cachedInputTokens is reported separately and must
  // produce its own llm.cached_input_tokens event.

  function setupRecordingMocks() {
    const account = makeAccount();
    vi.spyOn(UsageBillingRepository.prototype, 'getOrCreateBillingAccountForUser').mockResolvedValue(account);
    vi.spyOn(UsageBillingRepository.prototype, 'ensureActiveRateCard').mockResolvedValue({ id: 'rc_default_v1' });
    vi.spyOn(UsageBillingRepository.prototype, 'getAccountByUserId').mockResolvedValue(account);
    vi.spyOn(UsageBillingRepository.prototype, 'getOrCreateOpenPeriod').mockResolvedValue({ id: 'period_1' } as never);
    vi.spyOn(UsageBillingRepository.prototype, 'getRateCardItems').mockResolvedValue([]);
    const recordSpy = vi.spyOn(UsageBillingRepository.prototype, 'recordAndRateUsageBatch').mockResolvedValue(0);
    return { recordSpy };
  }

  it('records only llm.input_tokens when there are no cache hits', async () => {
    const { recordSpy } = setupRecordingMocks();
    const service = createService();

    service.recordLlmUsage({
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4-flash',
      inputTokens: 300,
      outputTokens: 80,
      phase: 'judge',
      turnIndex: 0,
    });

    await vi.waitFor(() => expect(recordSpy).toHaveBeenCalled());
    const events: Array<{ meterKey: string; quantity: number }> = recordSpy.mock.calls[0]![0] as never;
    const meterKeys = events.map((e) => e.meterKey);

    expect(meterKeys).toContain('llm.input_tokens');
    expect(meterKeys).not.toContain('llm.cached_input_tokens');
    expect(events.find((e) => e.meterKey === 'llm.input_tokens')!.quantity).toBe(300);
  });

  it('splits into llm.input_tokens and llm.cached_input_tokens when cache hits are present', async () => {
    // This mirrors the normalised contract: inputTokens is already non-cached
    // (the provider layer subtracted cached reads for the OpenAI path;
    // Anthropic already separates them).
    const { recordSpy } = setupRecordingMocks();
    const service = createService();

    service.recordLlmUsage({
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4-flash',
      inputTokens: 200,       // non-cached, as normalised by llm-provider.ts
      cachedInputTokens: 100, // prompt-cache reads, billed at a different rate
      outputTokens: 80,
      phase: 'judge',
      turnIndex: 0,
    });

    await vi.waitFor(() => expect(recordSpy).toHaveBeenCalled());
    const events: Array<{ meterKey: string; quantity: number }> = recordSpy.mock.calls[0]![0] as never;

    const inputEvent = events.find((e) => e.meterKey === 'llm.input_tokens');
    const cachedEvent = events.find((e) => e.meterKey === 'llm.cached_input_tokens');

    expect(inputEvent).toBeDefined();
    expect(inputEvent!.quantity).toBe(200); // not 200 - 100 = 100; no double-subtraction
    expect(cachedEvent).toBeDefined();
    expect(cachedEvent!.quantity).toBe(100);
  });

  it('records only llm.cached_input_tokens when all input was served from cache', async () => {
    const { recordSpy } = setupRecordingMocks();
    const service = createService();

    service.recordLlmUsage({
      provider: 'anthropic',
      model: 'anthropic/claude-sonnet-4-5',
      inputTokens: 0,         // Anthropic: input_tokens is the non-cached count
      cachedInputTokens: 150, // all prompt tokens were cache reads
      outputTokens: 60,
      phase: 'scout',
      turnIndex: 1,
    });

    await vi.waitFor(() => expect(recordSpy).toHaveBeenCalled());
    const events: Array<{ meterKey: string; quantity: number }> = recordSpy.mock.calls[0]![0] as never;
    const meterKeys = events.map((e) => e.meterKey);

    expect(meterKeys).not.toContain('llm.input_tokens');
    expect(meterKeys).toContain('llm.cached_input_tokens');
    expect(events.find((e) => e.meterKey === 'llm.cached_input_tokens')!.quantity).toBe(150);
  });

  it('preserves the original (dated) model ID in every event', async () => {
    const { recordSpy } = setupRecordingMocks();
    const service = createService();

    service.recordLlmUsage({
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4-flash-20260423',
      inputTokens: 100,
      cachedInputTokens: 50,
      outputTokens: 40,
      phase: 'judge',
      turnIndex: 0,
    });

    await vi.waitFor(() => expect(recordSpy).toHaveBeenCalled());
    const events: Array<{ meterKey: string; model: string }> = recordSpy.mock.calls[0]![0] as never;

    // The service stores the raw model ID; computeCharge handles the fallback match
    for (const event of events) {
      expect(event.model).toBe('deepseek/deepseek-v4-flash-20260423');
    }
  });
});