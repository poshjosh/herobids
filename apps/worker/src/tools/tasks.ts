import crypto from 'node:crypto';
import { z } from 'zod';
import type { AgentTool, ReminderConfig, ToolResult, ToolContext } from '@herobids/domain';
import { createLogger } from '../logger.js';
import { convertZodToJsonSchema } from './registry.js';
import {
  REMINDER_KEY_PATTERN,
  parseReminderRecord,
  type ReminderRecord,
} from '../reminders/reminder-record.js';

const logger = createLogger('tools:tasks');

// Tasks are stored as a Redis hash: agent:tasks:{agentId}
// Each field key is the task ID, value is a JSON-encoded task record.

interface TaskRecord {
  id: string;
  title: string;
  notes?: string;
  dueAt?: string;
  status: 'pending' | 'completed';
  createdAt: string;
  completedAt?: string;
}

// Reminders are stored as a Redis hash: agent:reminders:{agentId}
// Each field key is the reminder ID, value is a JSON-encoded reminder record.
// The record shape and validation live in ../reminders/reminder-record.ts.

const MINUTE_MS = 60_000;

function remindersKey(agentId: string): string {
  return `agent:reminders:${agentId}`;
}

// --- create_task ---

const CreateTaskParamsSchema = z.object({
  title: z.string().min(1).max(200).describe('Short title for the task'),
  notes: z.string().max(1000).optional().describe('Additional notes or context for the task'),
  dueAt: z.string().datetime().optional().describe('Due datetime in ISO 8601 UTC format'),
});

const createTaskTool: AgentTool = {
  name: 'create_task',
  description: 'Create a durable task with a title, optional notes, and optional due datetime (ISO 8601). Tasks persist across ticks and survive restarts.',
  parametersSchema: CreateTaskParamsSchema,
  parameters: convertZodToJsonSchema(CreateTaskParamsSchema),
  category: 'write-memory',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { title, notes, dueAt } = params as z.infer<typeof CreateTaskParamsSchema>;
    const id = crypto.randomUUID();
    const task: TaskRecord = {
      id,
      title,
      ...(notes ? { notes } : {}),
      ...(dueAt ? { dueAt } : {}),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    await ctx.redis.hset(`agent:tasks:${ctx.agentId}`, id, JSON.stringify(task));
    return { success: true, data: { ok: true, task } };
  },
};

// --- list_tasks ---

const ListTasksParamsSchema = z.object({
  status: z.enum(['pending', 'completed', 'all']).optional().describe('Filter by status: "pending" (default), "completed", or "all"'),
});

const listTasksTool: AgentTool = {
  name: 'list_tasks',
  description: 'List tasks. Use status "pending" (default) for active tasks, "completed" for finished, or "all" for everything.',
  parametersSchema: ListTasksParamsSchema,
  parameters: convertZodToJsonSchema(ListTasksParamsSchema),
  category: 'read-memory',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { status = 'pending' } = params as z.infer<typeof ListTasksParamsSchema>;
    const all = await ctx.redis.hgetall(`agent:tasks:${ctx.agentId}`);
    const tasks = all
      ? Object.values(all).map((v) => JSON.parse(v) as TaskRecord)
      : [];

    const filtered = status === 'all' ? tasks : tasks.filter((t) => t.status === status);
    // Sort by createdAt ascending
    filtered.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    return { success: true, data: { ok: true, tasks: filtered } };
  },
};

// --- complete_task ---

const CompleteTaskParamsSchema = z.object({
  id: z.string().min(1).describe('UUID of the task to mark as completed'),
});

const completeTaskTool: AgentTool = {
  name: 'complete_task',
  description: 'Mark a task as completed by its ID. Returns { ok: true, found: false } if the task does not exist.',
  parametersSchema: CompleteTaskParamsSchema,
  parameters: convertZodToJsonSchema(CompleteTaskParamsSchema),
  category: 'write-memory',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { id } = params as z.infer<typeof CompleteTaskParamsSchema>;
    const raw = await ctx.redis.hget(`agent:tasks:${ctx.agentId}`, id);
    if (raw === null) {
      return { success: true, data: { ok: true, found: false } };
    }

    const task = JSON.parse(raw) as TaskRecord;
    if (task.status === 'completed') {
      return { success: true, data: { ok: true, found: true, task } };
    }
    task.status = 'completed';
    task.completedAt = new Date().toISOString();
    await ctx.redis.hset(`agent:tasks:${ctx.agentId}`, id, JSON.stringify(task));

    return { success: true, data: { ok: true, found: true, task } };
  },
};

// --- schedule_reminder ---

const ScheduleReminderParamsSchema = z.object({
  message: z.string().min(1).max(500).describe('Reminder message that will be injected into your context at trigger time'),
  triggerAt: z.string().datetime().describe('Absolute trigger datetime in ISO 8601 UTC format (must be in the future). For a repeating reminder this is the first occurrence.'),
  repeatEveryMinutes: z.number().int().positive().optional().describe('If set, the reminder repeats on this interval (in minutes). Bounded by the operator minimum and maximum.'),
  key: z.string().regex(REMINDER_KEY_PATTERN).optional().describe('Stable identifier for this reminder. Scheduling again with the same key replaces the existing reminder.'),
});

function buildScheduleReminderTool(reminders: ReminderConfig): AgentTool {
  return {
    name: 'schedule_reminder',
    description:
      'Schedule a reminder at an absolute datetime (ISO 8601 UTC). It can repeat with `repeatEveryMinutes`. Scheduling with an existing `key` replaces that reminder.',
    parametersSchema: ScheduleReminderParamsSchema,
    parameters: convertZodToJsonSchema(ScheduleReminderParamsSchema),
    category: 'write-memory',
    async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
      const { message, triggerAt, repeatEveryMinutes, key } =
        params as z.infer<typeof ScheduleReminderParamsSchema>;

      const triggerDate = new Date(triggerAt);
      if (isNaN(triggerDate.getTime())) {
        return { success: false, error: 'triggerAt is not a valid datetime', fault: false };
      }
      if (triggerDate.getTime() <= Date.now()) {
        return { success: false, error: 'triggerAt must be in the future', fault: false };
      }

      let repeatEveryMs: number | undefined;
      if (repeatEveryMinutes !== undefined) {
        repeatEveryMs = repeatEveryMinutes * MINUTE_MS;
        if (
          repeatEveryMs < reminders.minRepeatIntervalMs ||
          repeatEveryMs > reminders.maxRepeatIntervalMs
        ) {
          return { success: false, error: 'reminder.invalid_interval', fault: false };
        }
      }

      const hashKey = remindersKey(ctx.agentId);
      const existing = await ctx.redis.hgetall(hashKey);
      const entries = existing ? Object.entries(existing) : [];

      // Replacement: find an existing record with the same key.
      let previousReminderId: string | undefined;
      if (key !== undefined) {
        for (const [field, raw] of entries) {
          const parsed = parseReminderRecord(raw);
          if (parsed.ok && parsed.data.key === key) {
            previousReminderId = field;
            break;
          }
        }
      }
      const replaced = previousReminderId !== undefined;

      // Limit: only enforced when not replacing an existing record.
      if (!replaced && entries.length >= reminders.maxActivePerAgent) {
        return { success: false, error: 'reminder.limit_exceeded', fault: false };
      }

      const id = crypto.randomUUID();
      const reminder: ReminderRecord = {
        id,
        message,
        triggerAt,
        scheduledBy: ctx.phase,
        createdAt: new Date().toISOString(),
        ...(key !== undefined ? { key } : {}),
        ...(repeatEveryMs !== undefined ? { repeatEveryMs, anchorAt: triggerAt } : {}),
      };

      if (replaced && previousReminderId !== undefined) {
        await ctx.redis.hdel(hashKey, previousReminderId);
      }
      await ctx.redis.hset(hashKey, id, JSON.stringify(reminder));

      return {
        success: true,
        data: {
          ok: true,
          reminderId: id,
          triggerAt,
          ...(repeatEveryMinutes !== undefined ? { repeatEveryMinutes } : {}),
          ...(key !== undefined ? { key } : {}),
          replaced,
          ...(previousReminderId !== undefined ? { previousReminderId } : {}),
        },
      };
    },
  };
}

// --- list_reminders ---

const ListRemindersParamsSchema = z.object({});

const listRemindersTool: AgentTool = {
  name: 'list_reminders',
  description: 'List your scheduled reminders, sorted by next trigger time.',
  parametersSchema: ListRemindersParamsSchema,
  parameters: convertZodToJsonSchema(ListRemindersParamsSchema),
  category: 'read-memory',
  async execute(_params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const all = await ctx.redis.hgetall(remindersKey(ctx.agentId));
    const reminders: Array<{
      reminderId: string;
      key?: string;
      message: string;
      nextTriggerAt: string;
      repeatEveryMinutes?: number;
      anchorAt?: string;
      lastFiredAt?: string;
    }> = [];

    for (const [field, raw] of Object.entries(all ?? {})) {
      const parsed = parseReminderRecord(raw);
      if (!parsed.ok) {
        logger.warn({ agentId: ctx.agentId, reminderId: field }, 'Skipping malformed reminder record');
        continue;
      }
      const record = parsed.data;
      reminders.push({
        reminderId: record.id,
        ...(record.key !== undefined ? { key: record.key } : {}),
        message: record.message,
        nextTriggerAt: record.triggerAt,
        ...(record.repeatEveryMs !== undefined
          ? { repeatEveryMinutes: record.repeatEveryMs / MINUTE_MS }
          : {}),
        ...(record.anchorAt !== undefined ? { anchorAt: record.anchorAt } : {}),
        ...(record.lastFiredAt !== undefined ? { lastFiredAt: record.lastFiredAt } : {}),
      });
    }

    reminders.sort((a, b) => a.nextTriggerAt.localeCompare(b.nextTriggerAt));

    return { success: true, data: { ok: true, reminders } };
  },
};

// --- cancel_reminder ---

const CancelReminderParamsSchema = z
  .object({
    reminderId: z.string().min(1).optional().describe('The reminderId to cancel'),
    key: z.string().min(1).optional().describe('The reminder key to cancel'),
  })
  .refine(
    (p) => (p.reminderId !== undefined) !== (p.key !== undefined),
    { message: 'reminder.invalid_target' },
  );

const cancelReminderTool: AgentTool = {
  name: 'cancel_reminder',
  description: 'Cancel a scheduled reminder by its reminderId or by its key. Provide exactly one.',
  parametersSchema: CancelReminderParamsSchema,
  parameters: convertZodToJsonSchema(CancelReminderParamsSchema),
  category: 'write-memory',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const parsedParams = CancelReminderParamsSchema.safeParse(params);
    if (!parsedParams.success) {
      return { success: false, error: 'reminder.invalid_target', fault: false };
    }
    const { reminderId, key } = parsedParams.data;
    const hashKey = remindersKey(ctx.agentId);

    if (reminderId !== undefined) {
      const removed = await ctx.redis.hdel(hashKey, reminderId);
      return { success: true, data: { ok: true, found: removed > 0 } };
    }

    // Cancel by key: find the matching record, then delete its field.
    const all = await ctx.redis.hgetall(hashKey);
    for (const [field, raw] of Object.entries(all ?? {})) {
      const parsed = parseReminderRecord(raw);
      if (parsed.ok && parsed.data.key === key) {
        const removed = await ctx.redis.hdel(hashKey, field);
        return { success: true, data: { ok: true, found: removed > 0 } };
      }
    }
    return { success: true, data: { ok: true, found: false } };
  },
};

/**
 * Build the task and reminder tools. The reminder bounds and limits come from
 * operator config (`agentRuntimePolicy.reminders`).
 */
export function createTaskTools(config: { reminders: ReminderConfig }): AgentTool[] {
  return [
    createTaskTool,
    listTasksTool,
    completeTaskTool,
    buildScheduleReminderTool(config.reminders),
    listRemindersTool,
    cancelReminderTool,
  ];
}

export type { ReminderRecord } from '../reminders/reminder-record.js';
