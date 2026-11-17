import { z } from 'zod';
import { FINISH_RUN_DEFAULT_REASON, FINISH_RUN_DEFAULT_STATUS, FINISH_RUN_REASON_MAX_LENGTH, FINISH_RUN_STATUSES } from '@herobids/domain';
import type { AgentTool, ToolResult } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';

// Both fields are optional (and may arrive as null, since the provider schema marks them nullable).
export const FinishRunParamsSchema = z.object({
  status: z.enum(FINISH_RUN_STATUSES).nullish(),
  reason: z.string().max(FINISH_RUN_REASON_MAX_LENGTH).nullish(),
});

export interface FinishRunRecord {
  status: (typeof FINISH_RUN_STATUSES)[number];
  reason: string;
}

/** Fills the defaults: status `complete`, reason `Done` (also for a blank reason). */
export function normalizeFinishRun(params: z.infer<typeof FinishRunParamsSchema>): FinishRunRecord {
  return {
    status: params.status ?? FINISH_RUN_DEFAULT_STATUS,
    reason: params.reason?.trim() || FINISH_RUN_DEFAULT_REASON,
  };
}

// The tool only validates and acknowledges; the agent process records the call.
// Not capability-gated: it needs no grant row.
export const finishRunTool: AgentTool = {
  name: 'finish_run',
  description: 'Call this to end a run. All arguments are optional: with no argument, the run ends as `complete` with the reason "Done". Status `complete` (default) when the goal for this run is done, `waiting` when you need something that has not arrived (a user answer, a later time), `blocked` when you cannot continue. The reason is an optional short sentence.',
  parametersSchema: FinishRunParamsSchema,
  parameters: convertZodToJsonSchema(FinishRunParamsSchema),
  category: 'write-messaging',
  async execute(params: unknown): Promise<ToolResult> {
    const parsed = FinishRunParamsSchema.safeParse(params);
    if (!parsed.success) {
      return { success: false, error: `Invalid finish_run parameters: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; ')}`, fault: false };
    }
    return { success: true, data: { ok: true, status: normalizeFinishRun(parsed.data).status, note: 'run end recorded' } };
  },
};
