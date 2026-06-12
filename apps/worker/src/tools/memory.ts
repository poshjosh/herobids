import { z } from 'zod';
import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';

// --- set_memory ---

const SetMemoryParamsSchema = z.object({
  key: z.string().min(1).describe('Key name for this memory entry'),
  value: z.unknown().describe('Value to store (string, number, object, array, etc.)'),
});

const setMemoryTool: AgentTool = {
  name: 'set_memory',
  description: 'Store a value in agent memory by key. Memory persists across ticks and survives agent restarts. Use for tracking state, decisions, or learned patterns.',
  parametersSchema: SetMemoryParamsSchema,
  parameters: convertZodToJsonSchema(SetMemoryParamsSchema),
  category: 'write-memory',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { key, value } = params as z.infer<typeof SetMemoryParamsSchema>;
    await ctx.redis.hset(`agent:memory:${ctx.agentId}`, key, JSON.stringify(value));

    return { success: true, data: { ok: true, key } };
  },
};

// --- get_memory ---

const GetMemoryParamsSchema = z.object({
  key: z.string().min(1).describe('Key name to retrieve'),
});

const getMemoryTool: AgentTool = {
  name: 'get_memory',
  description: 'Retrieve a previously stored memory value by key. Returns { ok: true, found: true, value } if the key exists, or { ok: true, found: false } if it does not.',
  parametersSchema: GetMemoryParamsSchema,
  parameters: convertZodToJsonSchema(GetMemoryParamsSchema),
  category: 'read-memory',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { key } = params as z.infer<typeof GetMemoryParamsSchema>;
    const raw = await ctx.redis.hget(`agent:memory:${ctx.agentId}`, key);

    if (raw === null) {
      return { success: true, data: { ok: true, found: false } };
    }

    try {
      const value = JSON.parse(raw) as unknown;
      return { success: true, data: { ok: true, found: true, value } };
    } catch {
      // Stored value was not valid JSON — return raw string
      return { success: true, data: { ok: true, found: true, value: raw } };
    }
  },
};

// --- list_memory_keys ---

const ListMemoryKeysParamsSchema = z.object({});

const listMemoryKeysTool: AgentTool = {
  name: 'list_memory_keys',
  description: 'List all keys currently stored in agent memory. Returns a sorted array of key names.',
  parametersSchema: ListMemoryKeysParamsSchema,
  parameters: convertZodToJsonSchema(ListMemoryKeysParamsSchema),
  category: 'read-memory',
  async execute(_params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const all = await ctx.redis.hgetall(`agent:memory:${ctx.agentId}`);
    const keys = all ? Object.keys(all).sort() : [];
    return { success: true, data: { ok: true, keys } };
  },
};

// --- delete_memory ---

const DeleteMemoryParamsSchema = z.object({
  keys: z.array(z.string().min(1)).min(1).describe('Array of key names to delete'),
});

const deleteMemoryTool: AgentTool = {
  name: 'delete_memory',
  description: 'Delete one or more memory keys. Reports how many keys were actually removed (missing keys are ignored).',
  parametersSchema: DeleteMemoryParamsSchema,
  parameters: convertZodToJsonSchema(DeleteMemoryParamsSchema),
  category: 'write-memory',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { keys } = params as z.infer<typeof DeleteMemoryParamsSchema>;
    const removed = await ctx.redis.hdel(`agent:memory:${ctx.agentId}`, ...keys);
    return { success: true, data: { ok: true, removed } };
  },
};

export const memoryTools: AgentTool[] = [
  setMemoryTool,
  getMemoryTool,
  listMemoryKeysTool,
  deleteMemoryTool,
];
