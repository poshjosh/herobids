import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RemindersConfigSchema } from '@herobids/domain';
import { ReminderCoordinator } from './reminder-coordinator.js';
import type { ReminderRecord } from './tools/tasks.js';

const WORKER_ID = 'worker-test';
const config = RemindersConfigSchema.parse({});

/**
 * Fake Redis with just the operations the coordinator uses: the reminder hash
 * (`hgetall`/`hset`/`hdel`) plus the lease primitives (`set` with NX, and the
 * `eval` scripts for renew/release). `leaseResult` controls whether the lease
 * can be acquired so a test can simulate "another worker holds it".
 */
function makeRedis(
  hashContents: Record<string, Record<string, string>> = {},
  { leaseResult = 'OK' as 'OK' | null } = {},
) {
  const store: Record<string, Record<string, string>> = {};
  for (const [key, fields] of Object.entries(hashContents)) {
    store[key] = { ...fields };
  }
  return {
    hgetall: vi.fn(async (key: string) => store[key] ?? null),
    hset: vi.fn(async (key: string, field: string, value: string) => {
      (store[key] ??= {})[field] = value;
      return 1;
    }),
    hdel: vi.fn(async (key: string, field: string) => {
      delete store[key]?.[field];
      return 1;
    }),
    set: vi.fn(async () => leaseResult),
    // Renew/release scripts both return 1 (we own the key) in the happy path.
    eval: vi.fn(async () => 1),
    __store: store,
  };
}

function makeAgentRepo(agentIds: string[] = ['agent-1']) {
  return {
    listActiveAgents: vi.fn().mockResolvedValue(agentIds.map((id) => ({ id }))),
  };
}

function makeEventPublisher() {
  return {
    emitAgentWake: vi.fn().mockResolvedValue(undefined),
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

function newCoordinator(
  redis: ReturnType<typeof makeRedis>,
  agentRepo: ReturnType<typeof makeAgentRepo>,
  eventPublisher: ReturnType<typeof makeEventPublisher>,
): ReminderCoordinator {
  return new ReminderCoordinator(
    redis as never,
    agentRepo as never,
    eventPublisher as never,
    WORKER_ID,
    config,
  );
}

function runTick(coordinator: ReminderCoordinator): Promise<void> {
  return (coordinator as unknown as { tick(): Promise<void> }).tick();
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

    const coordinator = newCoordinator(redis, agentRepo, eventPublisher);
    await runTick(coordinator);

    expect(eventPublisher.emitAgentWake).toHaveBeenCalledOnce();
    expect(eventPublisher.emitAgentWake).toHaveBeenCalledWith(
      'agent-1',
      expect.objectContaining({
        wakeId: 'rem-001',
        reason: 'Check BTC price',
        eventIds: ['rem-001'],
        source: 'reminder',
        context: expect.objectContaining({
          reminderId: 'rem-001',
          message: 'Check BTC price',
          scheduledBy: 'judge',
        }),
      }),
    );
  });

  it('emits typed reminder wake that the runtime can decode without the legacy prefix', async () => {
    const reminder = makeReminder({ id: 'rem-typed', message: 'Monitor SOL dip' });
    redis = makeRedis({
      'agent:reminders:agent-1': { 'rem-typed': JSON.stringify(reminder) },
    });

    const coordinator = newCoordinator(redis, agentRepo, eventPublisher);
    await runTick(coordinator);

    const call = (eventPublisher.emitAgentWake.mock.calls[0] as [string, Record<string, unknown>])[1];
    expect(call['source']).toBe('reminder');
    expect((call['context'] as Record<string, unknown>)['reminderId']).toBe('rem-typed');
    expect((call['context'] as Record<string, unknown>)['message']).toBe('Monitor SOL dip');
  });

  it('propagates scheduledBy:judge from reminder record to wake context', async () => {
    const reminder = makeReminder({ id: 'rem-j', message: 'Judge reminder', scheduledBy: 'judge' });
    redis = makeRedis({
      'agent:reminders:agent-1': { 'rem-j': JSON.stringify(reminder) },
    });

    const coordinator = newCoordinator(redis, agentRepo, eventPublisher);
    await runTick(coordinator);

    const call = (eventPublisher.emitAgentWake.mock.calls[0] as [string, Record<string, unknown>])[1];
    expect((call['context'] as Record<string, unknown>)['scheduledBy']).toBe('judge');
  });

  it('defaults scheduledBy to judge for legacy records without the field', async () => {
    // Simulate a record from before scheduledBy was added (no scheduledBy field)
    const legacyRecord = { id: 'rem-legacy', message: 'Legacy reminder', triggerAt: new Date(Date.now() - 1000).toISOString() };
    redis = makeRedis({
      'agent:reminders:agent-1': { 'rem-legacy': JSON.stringify(legacyRecord) },
    });

    const coordinator = newCoordinator(redis, agentRepo, eventPublisher);
    await runTick(coordinator);

    const call = (eventPublisher.emitAgentWake.mock.calls[0] as [string, Record<string, unknown>])[1];
    expect((call['context'] as Record<string, unknown>)['scheduledBy']).toBe('judge');
  });

  it('removes a one-shot reminder from Redis after emitting the wake', async () => {
    const reminder = makeReminder();
    redis = makeRedis({
      'agent:reminders:agent-1': { 'rem-001': JSON.stringify(reminder) },
    });

    const coordinator = newCoordinator(redis, agentRepo, eventPublisher);
    await runTick(coordinator);

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

    const coordinator = newCoordinator(redis, agentRepo, eventPublisher);
    await runTick(coordinator);

    expect(eventPublisher.emitAgentWake).not.toHaveBeenCalled();
    expect(redis.hset).not.toHaveBeenCalled();
  });

  it('skips a reminder that has already been fired', async () => {
    const firedReminder = makeReminder({ firedAt: new Date(Date.now() - 5000).toISOString() });
    redis = makeRedis({
      'agent:reminders:agent-1': { 'rem-001': JSON.stringify(firedReminder) },
    });

    const coordinator = newCoordinator(redis, agentRepo, eventPublisher);
    await runTick(coordinator);

    expect(eventPublisher.emitAgentWake).not.toHaveBeenCalled();
  });

  it('skips a malformed reminder record without throwing', async () => {
    redis = makeRedis({
      'agent:reminders:agent-1': { 'rem-bad': 'not-valid-json' },
    });

    const coordinator = newCoordinator(redis, agentRepo, eventPublisher);
    await expect(runTick(coordinator)).resolves.not.toThrow();
    expect(eventPublisher.emitAgentWake).not.toHaveBeenCalled();
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

    const coordinator = newCoordinator(redis, agentRepo, eventPublisher);
    await runTick(coordinator);

    expect(eventPublisher.emitAgentWake).toHaveBeenCalledTimes(2);
    const calls = eventPublisher.emitAgentWake.mock.calls as Array<[string, { reason: string }]>;
    const agentIds = calls.map(([id]) => id).sort();
    expect(agentIds).toEqual(['agent-1', 'agent-2']);
  });

  // --- WP5: lease, repeating schedule, failure handling ---

  it('fires nothing when the lease is held by another worker', async () => {
    redis = makeRedis(
      { 'agent:reminders:agent-1': { 'rem-001': JSON.stringify(makeReminder()) } },
      { leaseResult: null }, // SET ... NX returns null — lease not acquired
    );

    const coordinator = newCoordinator(redis, agentRepo, eventPublisher);
    await runTick(coordinator);

    expect(redis.hgetall).not.toHaveBeenCalled();
    expect(eventPublisher.emitAgentWake).not.toHaveBeenCalled();
  });

  it('re-schedules a due repeating reminder onto the next grid slot and does not delete it', async () => {
    const repeatEveryMs = 15 * 60_000; // 15 minutes
    const triggerAt = new Date(Date.now() - 1000).toISOString(); // just past
    const reminder = makeReminder({
      id: 'rem-rep',
      message: 'Repeat me',
      triggerAt,
      repeatEveryMs,
      anchorAt: triggerAt,
    });
    redis = makeRedis({
      'agent:reminders:agent-1': { 'rem-rep': JSON.stringify(reminder) },
    });

    const coordinator = newCoordinator(redis, agentRepo, eventPublisher);
    await runTick(coordinator);

    expect(eventPublisher.emitAgentWake).toHaveBeenCalledOnce();
    expect(redis.hdel).not.toHaveBeenCalled();
    expect(redis.hset).toHaveBeenCalledOnce();

    const [, , value] = redis.hset.mock.calls[0] as [string, string, string];
    const stored = JSON.parse(value) as ReminderRecord;
    const triggerMs = new Date(triggerAt).getTime();
    expect(new Date(stored.triggerAt).getTime()).toBe(triggerMs + repeatEveryMs);
    expect(stored.repeatEveryMs).toBe(repeatEveryMs);
    expect(stored.lastFiredAt).toBeDefined();

    const context = (eventPublisher.emitAgentWake.mock.calls[0] as [string, Record<string, unknown>])[1]['context'] as Record<string, unknown>;
    expect(context['repeatEveryMs']).toBe(repeatEveryMs);
    expect(context['missedOccurrences']).toBe(0);
    expect(context['nextTriggerAt']).toBe(stored.triggerAt);
    expect(context['scheduledFor']).toBe(triggerAt);
  });

  it('fires a late repeating reminder once and reports the missed occurrences', async () => {
    const repeatEveryMs = 15 * 60_000; // 15 minutes
    // Due slot is ~3.5 intervals in the past → 3 missed occurrences after the due one.
    const triggerMs = Date.now() - Math.floor(3.5 * repeatEveryMs);
    const triggerAt = new Date(triggerMs).toISOString();
    const reminder = makeReminder({
      id: 'rem-late',
      message: 'Catch up',
      triggerAt,
      repeatEveryMs,
      anchorAt: triggerAt,
    });
    redis = makeRedis({
      'agent:reminders:agent-1': { 'rem-late': JSON.stringify(reminder) },
    });

    const coordinator = newCoordinator(redis, agentRepo, eventPublisher);
    await runTick(coordinator);

    expect(eventPublisher.emitAgentWake).toHaveBeenCalledOnce();
    const context = (eventPublisher.emitAgentWake.mock.calls[0] as [string, Record<string, unknown>])[1]['context'] as Record<string, unknown>;
    expect(context['missedOccurrences']).toBe(3);

    const [, , value] = redis.hset.mock.calls[0] as [string, string, string];
    const stored = JSON.parse(value) as ReminderRecord;
    // Next slot stays on the original grid and is strictly in the future.
    expect(new Date(stored.triggerAt).getTime()).toBe(triggerMs + 4 * repeatEveryMs);
    expect(new Date(stored.triggerAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('leaves the record unchanged when the publish fails', async () => {
    eventPublisher.emitAgentWake.mockRejectedValueOnce(new Error('publish boom'));
    const reminder = makeReminder();
    redis = makeRedis({
      'agent:reminders:agent-1': { 'rem-001': JSON.stringify(reminder) },
    });

    const coordinator = newCoordinator(redis, agentRepo, eventPublisher);
    await expect(runTick(coordinator)).resolves.not.toThrow();

    expect(redis.hdel).not.toHaveBeenCalled();
    expect(redis.hset).not.toHaveBeenCalled();
  });

  it('releases the lease on stop', async () => {
    const coordinator = newCoordinator(redis, agentRepo, eventPublisher);
    // Acquire the lease by running one tick.
    await runTick(coordinator);
    redis.eval.mockClear();

    await coordinator.stop();

    // The release script is sent exactly once.
    expect(redis.eval).toHaveBeenCalledOnce();
  });

  // --- M1: overlapping-tick guard and stop() drain ---

  it('ignores a concurrent tick while a prior tick is still in flight', async () => {
    const reminder = makeReminder();
    redis = makeRedis({
      'agent:reminders:agent-1': { 'rem-001': JSON.stringify(reminder) },
    });

    // Block the first tick inside listActiveAgents until we release the gate.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let callCount = 0;
    agentRepo.listActiveAgents = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) await gate;
      return [{ id: 'agent-1' }];
    });

    const coordinator = newCoordinator(redis, agentRepo, eventPublisher);

    // Kick off two ticks without awaiting the first.
    const first = runTick(coordinator);
    const second = runTick(coordinator);

    // The second tick returns immediately as a no-op while the first is blocked.
    await second;
    expect(eventPublisher.emitAgentWake).not.toHaveBeenCalled();

    // Release the first tick and let it finish.
    release();
    await first;

    // The reminder is processed exactly once despite the concurrent invocation.
    expect(agentRepo.listActiveAgents).toHaveBeenCalledOnce();
    expect(eventPublisher.emitAgentWake).toHaveBeenCalledOnce();
    expect(redis.hdel).toHaveBeenCalledOnce();
  });

  it('awaits the in-flight tick before releasing the lease on stop', async () => {
    const reminder = makeReminder();
    redis = makeRedis({
      'agent:reminders:agent-1': { 'rem-001': JSON.stringify(reminder) },
    });

    // Hold the publish open so a tick is genuinely in flight when stop() runs.
    let releasePublish!: () => void;
    const publishGate = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    let publishSettled = false;
    eventPublisher.emitAgentWake = vi.fn(async () => {
      await publishGate;
      publishSettled = true;
    });

    // Record whether the lease-release (del) script ever runs before the
    // in-flight publish has settled — that would be the M1 regression.
    let leaseReleasedWhilePublishing = false;
    const originalEval = redis.eval.getMockImplementation()!;
    redis.eval = vi.fn(async (...args: Parameters<typeof originalEval>) => {
      const script = args[0] as string;
      if (script.includes('del') && !publishSettled) {
        leaseReleasedWhilePublishing = true;
      }
      return originalEval(...args);
    }) as typeof redis.eval;

    const coordinator = newCoordinator(redis, agentRepo, eventPublisher);

    // Drive one tick directly and register it as the in-flight drain promise,
    // exactly as start()'s interval callback would.
    const tickPromise = runTick(coordinator);
    (coordinator as unknown as { tickDrain: Promise<void> }).tickDrain = tickPromise;

    // Begin stop(); it must block on the drain until the publish resolves.
    const stopPromise = coordinator.stop();

    // Let the event loop turn — stop() must NOT have released the lease yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(leaseReleasedWhilePublishing).toBe(false);

    // Resolve the publish; the tick completes, then stop() releases the lease.
    releasePublish();
    await stopPromise;

    expect(eventPublisher.emitAgentWake).toHaveBeenCalledOnce();
    // The release script ran, and only after the publish had settled.
    expect(redis.eval).toHaveBeenCalled();
    expect(leaseReleasedWhilePublishing).toBe(false);
  });
});
