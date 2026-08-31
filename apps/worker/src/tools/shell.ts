import { z } from 'zod';
import type { AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';

const ShellExecuteParamsSchema = z.object({
  command: z.string().min(1).describe('Shell command to execute'),
  timeoutMs: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(600_000)
    .optional()
    .describe('Execution timeout in milliseconds (1000-600000)'),
  workingDir: z.string().optional().describe('Working directory relative to workspace root'),
  description: z.string().optional().describe('Brief description of what this command does. For audit/logging.'),
});

/**
 * Stub implementation for `execute_shell`.
 * The full implementation (sandbox-exec.sh wrapping, permission-level gating,
 * root access for full mode) is added in Phase 2.
 */
const executeShellTool: AgentTool = {
  name: 'execute_shell',
  description: 'Execute arbitrary shell commands in the agent workspace. Available at standard and full permission levels.',
  parametersSchema: ShellExecuteParamsSchema,
  parameters: convertZodToJsonSchema(ShellExecuteParamsSchema),
  category: 'execute-filesystem',
  execute: async (_params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    return {
      success: false,
      error: 'execute_shell is not yet available. Use execute_code instead.',
      errorCode: 'tool.not_implemented',
      retryable: false,
    };
  },
};

export const shellTools: AgentTool[] = [executeShellTool];
