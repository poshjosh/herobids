import { z } from 'zod';
import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';

// --- set_memory ---

const SetMemoryParamsSchema = z.object({
  key: z.string().min(1),
  value: z.unknown(),
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

export const memoryTools: AgentTool[] = [
  setMemoryTool,
];
