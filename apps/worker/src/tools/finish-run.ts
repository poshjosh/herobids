import { z } from 'zod';
import { FINISH_RUN_REASON_MAX_LENGTH, FINISH_RUN_STATUSES } from '@herobids/domain';
import type { AgentTool, ToolResult } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';

export const FinishRunParamsSchema = z.object({
  status: z.enum(FINISH_RUN_STATUSES),
  reason: z.string().min(1).max(FINISH_RUN_REASON_MAX_LENGTH),
});

// The tool only validates and acknowledges; the agent process records the call.
// Not capability-gated: it needs no grant row.
export const finishRunTool: AgentTool = {
  name: 'finish_run',
  description: 'Call this to end a run. Status `complete` when the goal for this run is done, `waiting` when you need something that has not arrived (a user answer, a later time), `blocked` when you cannot continue. The reason is a short sentence.',
  parametersSchema: FinishRunParamsSchema,
  parameters: convertZodToJsonSchema(FinishRunParamsSchema),
  category: 'write-messaging',
  async execute(params: unknown): Promise<ToolResult> {
    const parsed = FinishRunParamsSchema.safeParse(params);
    if (!parsed.success) {
      return { success: false, error: `Invalid finish_run parameters: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; ')}`, fault: false };
    }
    return { success: true, data: { ok: true, status: parsed.data.status, note: 'run end recorded' } };
  },
};
