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
});