import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReminderCoordinator } from './reminder-coordinator.js';
import type { ReminderRecord } from './tools/tasks.js';

function makeRedis(hashContents: Record<string, Record<string, string>> = {}) {
  return {
    hgetall: vi.fn(async (key: string) => hashContents[key] ?? null),
    hset: vi.fn(async () => 1),
    hdel: vi.fn(async () => 1),
  };
}

function makeAgentRepo(agentIds: string[] = ['agent-1']) {
  return {
    listActiveAgents: vi.fn().mockResolvedValue(agentIds.map((id) => ({ id }))),
  };
}

function makeEventPublisher() {
  return {
    emitAgentMarketWake: vi.fn().mockResolvedValue(undefined),
  };
}

function makeReminder(overrides: Partial<ReminderRecord> = {}): ReminderRecord {
  return {
    id: 'rem-001',
    message: 'Check BTC price',
    triggerAt: new Date(Date.now() - 1000).toISOString(), // 1 second in the past — due now
    ...overrides,
  };
}

describe('ReminderCoordinator', () => {
  let redis: ReturnType<typeof makeRedis>;
  let agentRepo: ReturnType<typeof makeAgentRepo>;
  let eventPublisher: ReturnType<typeof makeEventPublisher>;

  beforeEach(() => {
    redis = makeRedis();
    agentRepo = makeAgentRepo();
    eventPublisher = makeEventPublisher();
  });

  it('fires a wake event for a due reminder', async () => {
    const reminder = makeReminder();
    redis = makeRedis({
      'agent:reminders:agent-1': { 'rem-001': JSON.stringify(reminder) },
    });

    const coordinator = new ReminderCoordinator(redis as never, agentRepo as never, eventPublisher as never);
    // Access private tick() via type casting
    await (coordinator as unknown as { tick(): Promise<void> }).tick();

    expect(eventPublisher.emitAgentMarketWake).toHaveBeenCalledOnce();
    expect(eventPublisher.emitAgentMarketWake).toHaveBeenCalledWith(
      'agent-1',
      expect.objectContaining({
        wakeId: 'reminder:rem-001',
        reason: 'reminder:Check BTC price',
        eventIds: ['rem-001'],
      }),
    );
  });

  it('removes the reminder from Redis after emitting the wake', async () => {
    const reminder = makeReminder();
    redis = makeRedis({
      'agent:reminders:agent-1': { 'rem-001': JSON.stringify(reminder) },
    });

    const coordinator = new ReminderCoordinator(redis as never, agentRepo as never, eventPublisher as never);
    await (coordinator as unknown as { tick(): Promise<void> }).tick();

    expect(redis.hdel).toHaveBeenCalledOnce();
    const [key, reminderId] = redis.hdel.mock.calls[0] as [string, string];
    expect(key).toBe('agent:reminders:agent-1');
    expect(reminderId).toBe('rem-001');
    expect(redis.hset).not.toHaveBeenCalled();
  });

  it('skips a reminder that is not yet due', async () => {
    const futureReminder = makeReminder({
      triggerAt: new Date(Date.now() + 60_000).toISOString(), // 1 minute in future
    });
    redis = makeRedis({
      'agent:reminders:agent-1': { 'rem-future': JSON.stringify(futureReminder) },
    });

    const coordinator = new ReminderCoordinator(redis as never, agentRepo as never, eventPublisher as never);
    await (coordinator as unknown as { tick(): Promise<void> }).tick();

    expect(eventPublisher.emitAgentMarketWake).not.toHaveBeenCalled();
    expect(redis.hset).not.toHaveBeenCalled();
  });

  it('skips a reminder that has already been fired', async () => {
    const firedReminder = makeReminder({ firedAt: new Date(Date.now() - 5000).toISOString() });
    redis = makeRedis({
      'agent:reminders:agent-1': { 'rem-001': JSON.stringify(firedReminder) },
    });

    const coordinator = new ReminderCoordinator(redis as never, agentRepo as never, eventPublisher as never);
    await (coordinator as unknown as { tick(): Promise<void> }).tick();

    expect(eventPublisher.emitAgentMarketWake).not.toHaveBeenCalled();
  });

  it('skips a malformed reminder record without throwing', async () => {
    redis = makeRedis({
      'agent:reminders:agent-1': { 'rem-bad': 'not-valid-json' },
    });

    const coordinator = new ReminderCoordinator(redis as never, agentRepo as never, eventPublisher as never);
    await expect(
      (coordinator as unknown as { tick(): Promise<void> }).tick(),
    ).resolves.not.toThrow();
    expect(eventPublisher.emitAgentMarketWake).not.toHaveBeenCalled();
  });

  it('processes multiple due reminders across multiple agents', async () => {
    agentRepo = makeAgentRepo(['agent-1', 'agent-2']);
    redis = makeRedis({
      'agent:reminders:agent-1': {
        'rem-a': JSON.stringify(makeReminder({ id: 'rem-a', message: 'Message A' })),
      },
      'agent:reminders:agent-2': {
        'rem-b': JSON.stringify(makeReminder({ id: 'rem-b', message: 'Message B' })),
      },
    });

    const coordinator = new ReminderCoordinator(redis as never, agentRepo as never, eventPublisher as never);
    await (coordinator as unknown as { tick(): Promise<void> }).tick();

    expect(eventPublisher.emitAgentMarketWake).toHaveBeenCalledTimes(2);
    const calls = eventPublisher.emitAgentMarketWake.mock.calls as Array<[string, { reason: string }]>;
    const agentIds = calls.map(([id]) => id).sort();
    expect(agentIds).toEqual(['agent-1', 'agent-2']);
  });
});
