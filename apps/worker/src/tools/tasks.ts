import crypto from 'node:crypto';
import { z } from 'zod';
import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';

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

interface ReminderRecord {
  id: string;
  message: string;
  triggerAt: string;
  firedAt?: string;
  scheduledBy?: 'scout' | 'judge';
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
  triggerAt: z.string().datetime().describe('Absolute trigger datetime in ISO 8601 UTC format (must be in the future)'),
});

const scheduleReminderTool: AgentTool = {
  name: 'schedule_reminder',
  description: 'Schedule a one-shot reminder at a specific absolute datetime (ISO 8601 UTC). The platform will wake you at or after that time with the reminder message in structured context.',
  parametersSchema: ScheduleReminderParamsSchema,
  parameters: convertZodToJsonSchema(ScheduleReminderParamsSchema),
  category: 'write-memory',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { message, triggerAt } = params as z.infer<typeof ScheduleReminderParamsSchema>;

    const triggerDate = new Date(triggerAt);
    if (isNaN(triggerDate.getTime())) {
      return { success: false, error: 'triggerAt is not a valid datetime', fault: false };
    }
    if (triggerDate.getTime() <= Date.now()) {
      return { success: false, error: 'triggerAt must be in the future', fault: false };
    }

    const id = crypto.randomUUID();
    const reminder: ReminderRecord = {
      id,
      message,
      triggerAt,
      scheduledBy: ctx.phase,
    };
    await ctx.redis.hset(`agent:reminders:${ctx.agentId}`, id, JSON.stringify(reminder));

    return {
      success: true,
      data: { ok: true, reminderId: id, triggerAt },
    };
  },
};

export const taskTools: AgentTool[] = [
  createTaskTool,
  listTasksTool,
  completeTaskTool,
  scheduleReminderTool,
];

export type { ReminderRecord };
