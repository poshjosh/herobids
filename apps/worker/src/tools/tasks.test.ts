import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RemindersConfigSchema, type ReminderConfig } from '@herobids/domain';
import { createTaskTools } from './tasks.js';

const reminders: ReminderConfig = RemindersConfigSchema.parse({});
const taskTools = createTaskTools({ reminders });

function makeCtx(store: Record<string, Record<string, string>> = {}, phase: 'scout' | 'judge' = 'judge'): Parameters<typeof taskTools[0]['execute']>[1] {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    phase,
    redis: {
      hset: vi.fn(async (key: string, field: string, value: string) => {
        store[key] ??= {};
        store[key]![field] = value;
        return 1;
      }),
      hget: vi.fn(async (key: string, field: string) => store[key]?.[field] ?? null),
      hgetall: vi.fn(async (key: string) => store[key] ?? null),
      hdel: vi.fn(async (key: string, ...fields: string[]) => {
        let count = 0;
        for (const f of fields) {
          if (store[key]?.[f] !== undefined) { delete store[key]![f]; count++; }
        }
        return count;
      }),
      publish: vi.fn(async () => 0),
    },
    publishToInbound: vi.fn(async () => undefined),
  };
}

const createTask = taskTools.find((t) => t.name === 'create_task')!;
const listTasks = taskTools.find((t) => t.name === 'list_tasks')!;
const completeTask = taskTools.find((t) => t.name === 'complete_task')!;
const scheduleReminder = taskTools.find((t) => t.name === 'schedule_reminder')!;
const listReminders = taskTools.find((t) => t.name === 'list_reminders')!;
const cancelReminder = taskTools.find((t) => t.name === 'cancel_reminder')!;

describe('task tools', () => {
  let store: Record<string, Record<string, string>>;
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    store = {};
    ctx = makeCtx(store);
  });

  it('create/list/complete round-trip', async () => {
    // create
    const createResult = await createTask.execute({ title: 'Write tests', notes: 'vitest' }, ctx);
    expect(createResult.success).toBe(true);
    const taskId = (createResult.data as { task: { id: string } }).task.id;
    expect(taskId).toBeTruthy();

    // list pending
    const listResult = await listTasks.execute({ status: 'pending' }, ctx);
    expect(listResult.success).toBe(true);
    const tasks = (listResult.data as { tasks: Array<{ id: string; status: string }> }).tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.id).toBe(taskId);
    expect(tasks[0]!.status).toBe('pending');

    // complete
    const completeResult = await completeTask.execute({ id: taskId }, ctx);
    expect(completeResult.success).toBe(true);
    expect((completeResult.data as { found: boolean }).found).toBe(true);

    // list pending should now be empty
    const listAfter = await listTasks.execute({ status: 'pending' }, ctx);
    expect((listAfter.data as { tasks: unknown[] }).tasks).toHaveLength(0);

    // list completed should have the task
    const listCompleted = await listTasks.execute({ status: 'completed' }, ctx);
    expect((listCompleted.data as { tasks: Array<{ id: string; status: string }> }).tasks).toHaveLength(1);
    expect((listCompleted.data as { tasks: Array<{ id: string; status: string }> }).tasks[0]!.status).toBe('completed');
  });

  it('complete on missing task returns found:false', async () => {
    const result = await completeTask.execute({ id: 'non-existent-id' }, ctx);
    expect(result.success).toBe(true);
    expect((result.data as { found: boolean }).found).toBe(false);
  });

  it('complete_task preserves completedAt on repeated completion', async () => {
    const createResult = await createTask.execute({ title: 'Finish report' }, ctx);
    const taskId = (createResult.data as { task: { id: string } }).task.id;

    const first = await completeTask.execute({ id: taskId }, ctx);
    const firstTask = (first.data as { task: { completedAt?: string } }).task;
    expect(firstTask.completedAt).toBeDefined();

    const second = await completeTask.execute({ id: taskId }, ctx);
    const secondTask = (second.data as { task: { completedAt?: string } }).task;
    expect(secondTask.completedAt).toBe(firstTask.completedAt);
  });

  it('schedule_reminder stores a reminder record', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const result = await scheduleReminder.execute({ message: 'check portfolio', triggerAt: future }, ctx);
    expect(result.success).toBe(true);
    const reminderId = (result.data as { reminderId: string }).reminderId;
    expect(reminderId).toBeTruthy();
    // Verify stored in redis
    const raw = store[`agent:reminders:agent-1`]?.[reminderId];
    expect(raw).toBeDefined();
    const record = JSON.parse(raw!) as { message: string; triggerAt: string; scheduledBy: string };
    expect(record.message).toBe('check portfolio');
    expect(record.triggerAt).toBe(future);
    expect(record.scheduledBy).toBe('judge');
  });

  it('schedule_reminder records scheduledBy:scout when phase is scout', async () => {
    const scoutCtx = makeCtx(store, 'scout');
    const future = new Date(Date.now() + 60_000).toISOString();
    const result = await scheduleReminder.execute({ message: 'scout check', triggerAt: future }, scoutCtx);
    expect(result.success).toBe(true);
    const reminderId = (result.data as { reminderId: string }).reminderId;
    const raw = store[`agent:reminders:agent-1`]?.[reminderId];
    const record = JSON.parse(raw!) as { scheduledBy: string };
    expect(record.scheduledBy).toBe('scout');
  });

  it('schedule_reminder rejects past dates', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const result = await scheduleReminder.execute({ message: 'too late', triggerAt: past }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('future');
  });

  describe('schedule_reminder — repeating and keys', () => {
    const future = () => new Date(Date.now() + 60_000).toISOString();

    it('behaves exactly as before for a one-shot reminder without a key', async () => {
      const triggerAt = future();
      const result = await scheduleReminder.execute({ message: 'one shot', triggerAt }, ctx);
      expect(result.success).toBe(true);
      const data = result.data as { reminderId: string; triggerAt: string; replaced: boolean; key?: string; repeatEveryMinutes?: number };
      expect(data.triggerAt).toBe(triggerAt);
      expect(data.replaced).toBe(false);
      expect(data.key).toBeUndefined();
      expect(data.repeatEveryMinutes).toBeUndefined();

      const raw = store['agent:reminders:agent-1']?.[data.reminderId];
      const record = JSON.parse(raw!) as Record<string, unknown>;
      expect(record['repeatEveryMs']).toBeUndefined();
      expect(record['anchorAt']).toBeUndefined();
      expect(record['key']).toBeUndefined();
    });

    it('rejects a repeat below the operator minimum', async () => {
      const belowMin = Math.floor(reminders.minRepeatIntervalMs / 60_000) - 1;
      const result = await scheduleReminder.execute(
        { message: 'too frequent', triggerAt: future(), repeatEveryMinutes: belowMin },
        ctx,
      );
      expect(result.success).toBe(false);
      expect(result.error).toBe('reminder.invalid_interval');
    });

    it('rejects a repeat above the operator maximum', async () => {
      const aboveMax = Math.ceil(reminders.maxRepeatIntervalMs / 60_000) + 1;
      const result = await scheduleReminder.execute(
        { message: 'too rare', triggerAt: future(), repeatEveryMinutes: aboveMax },
        ctx,
      );
      expect(result.success).toBe(false);
      expect(result.error).toBe('reminder.invalid_interval');
    });

    it('stores repeatEveryMs and anchorAt for a repeating reminder', async () => {
      const triggerAt = future();
      const minutes = reminders.minRepeatIntervalMs / 60_000;
      const result = await scheduleReminder.execute(
        { message: 'daily', triggerAt, repeatEveryMinutes: minutes, key: 'daily_report' },
        ctx,
      );
      expect(result.success).toBe(true);
      const data = result.data as { reminderId: string; repeatEveryMinutes?: number; key?: string };
      expect(data.repeatEveryMinutes).toBe(minutes);
      expect(data.key).toBe('daily_report');

      const raw = store['agent:reminders:agent-1']?.[data.reminderId];
      const record = JSON.parse(raw!) as { repeatEveryMs: number; anchorAt: string; key: string };
      expect(record.repeatEveryMs).toBe(reminders.minRepeatIntervalMs);
      expect(record.anchorAt).toBe(triggerAt);
      expect(record.key).toBe('daily_report');
    });

    it('replaces an existing reminder with the same key and reports the previous id', async () => {
      const first = await scheduleReminder.execute(
        { message: 'v1', triggerAt: future(), key: 'report' },
        ctx,
      );
      const firstId = (first.data as { reminderId: string }).reminderId;

      const second = await scheduleReminder.execute(
        { message: 'v2', triggerAt: future(), key: 'report' },
        ctx,
      );
      expect(second.success).toBe(true);
      const data = second.data as { reminderId: string; replaced: boolean; previousReminderId?: string };
      expect(data.replaced).toBe(true);
      expect(data.previousReminderId).toBe(firstId);
      expect(data.reminderId).not.toBe(firstId);

      // Only one record remains, and it is the new one.
      const hash = store['agent:reminders:agent-1']!;
      expect(Object.keys(hash)).toHaveLength(1);
      expect(hash[firstId]).toBeUndefined();
      const record = JSON.parse(hash[data.reminderId]!) as { message: string };
      expect(record.message).toBe('v2');
    });

    it('enforces the active-reminder limit when not replacing', async () => {
      const limited = createTaskTools({ reminders: { ...reminders, maxActivePerAgent: 2 } });
      const schedule = limited.find((t) => t.name === 'schedule_reminder')!;

      await schedule.execute({ message: 'a', triggerAt: future() }, ctx);
      await schedule.execute({ message: 'b', triggerAt: future() }, ctx);
      const third = await schedule.execute({ message: 'c', triggerAt: future() }, ctx);
      expect(third.success).toBe(false);
      expect(third.error).toBe('reminder.limit_exceeded');
    });

    it('does not enforce the limit when replacing an existing key', async () => {
      const limited = createTaskTools({ reminders: { ...reminders, maxActivePerAgent: 2 } });
      const schedule = limited.find((t) => t.name === 'schedule_reminder')!;

      await schedule.execute({ message: 'a', triggerAt: future(), key: 'a' }, ctx);
      await schedule.execute({ message: 'b', triggerAt: future(), key: 'b' }, ctx);
      // At the limit, but replacing key 'a' must still succeed.
      const replace = await schedule.execute({ message: 'a2', triggerAt: future(), key: 'a' }, ctx);
      expect(replace.success).toBe(true);
      expect((replace.data as { replaced: boolean }).replaced).toBe(true);
    });
  });

  describe('list_reminders', () => {
    const future = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

    it('returns reminders sorted by next trigger time', async () => {
      await scheduleReminder.execute({ message: 'later', triggerAt: future(300_000), key: 'later' }, ctx);
      await scheduleReminder.execute({ message: 'sooner', triggerAt: future(60_000), key: 'sooner' }, ctx);

      const result = await listReminders.execute({}, ctx);
      expect(result.success).toBe(true);
      const list = (result.data as { reminders: Array<{ message: string; nextTriggerAt: string }> }).reminders;
      expect(list.map((r) => r.message)).toEqual(['sooner', 'later']);
    });

    it('skips malformed records', async () => {
      await scheduleReminder.execute({ message: 'valid', triggerAt: future(60_000) }, ctx);
      store['agent:reminders:agent-1']!['broken'] = 'not json';

      const result = await listReminders.execute({}, ctx);
      const list = (result.data as { reminders: Array<{ message: string }> }).reminders;
      expect(list).toHaveLength(1);
      expect(list[0]!.message).toBe('valid');
    });
  });

  describe('cancel_reminder', () => {
    const future = () => new Date(Date.now() + 60_000).toISOString();

    it('cancels by reminderId', async () => {
      const created = await scheduleReminder.execute({ message: 'x', triggerAt: future() }, ctx);
      const reminderId = (created.data as { reminderId: string }).reminderId;

      const result = await cancelReminder.execute({ reminderId }, ctx);
      expect(result.success).toBe(true);
      expect((result.data as { found: boolean }).found).toBe(true);
      expect(store['agent:reminders:agent-1']?.[reminderId]).toBeUndefined();
    });

    it('cancels by key', async () => {
      await scheduleReminder.execute({ message: 'x', triggerAt: future(), key: 'sweep' }, ctx);

      const result = await cancelReminder.execute({ key: 'sweep' }, ctx);
      expect(result.success).toBe(true);
      expect((result.data as { found: boolean }).found).toBe(true);
      expect(Object.keys(store['agent:reminders:agent-1'] ?? {})).toHaveLength(0);
    });

    it('returns found:false for an unknown target', async () => {
      const byId = await cancelReminder.execute({ reminderId: 'nope' }, ctx);
      expect((byId.data as { found: boolean }).found).toBe(false);

      const byKey = await cancelReminder.execute({ key: 'missing' }, ctx);
      expect((byKey.data as { found: boolean }).found).toBe(false);
    });

    it('rejects when both targets are provided', async () => {
      const result = await cancelReminder.execute({ reminderId: 'a', key: 'b' }, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toBe('reminder.invalid_target');
    });

    it('rejects when neither target is provided', async () => {
      const result = await cancelReminder.execute({}, ctx);
      expect(result.success).toBe(false);
      expect(result.error).toBe('reminder.invalid_target');
    });
  });
});
