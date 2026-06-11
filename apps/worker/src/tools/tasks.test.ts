import { describe, it, expect, vi, beforeEach } from 'vitest';
import { taskTools } from './tasks.js';

function makeCtx(store: Record<string, Record<string, string>> = {}): Parameters<typeof taskTools[0]['execute']>[1] {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
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
    const record = JSON.parse(raw!) as { message: string; triggerAt: string };
    expect(record.message).toBe('check portfolio');
    expect(record.triggerAt).toBe(future);
  });

  it('schedule_reminder rejects past dates', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const result = await scheduleReminder.execute({ message: 'too late', triggerAt: past }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('future');
  });
});
