import { z } from 'zod';
import type { AgentAllowance, AgentPlatformError, AgentTool, ToolResult, ToolContext } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';

/**
 * Agent-created agents (001-plan §8). Every tool calls the platform API as this agent. The API
 * derives lineage from the agent key, so no tool input can name a creator, parent or depth.
 */

export const CREATE_AGENT_TOOL_NAME = 'create_agent';

/** Creator tools act on direct children and are shown only when the agent has at least one. */
export const CREATOR_TOOL_NAMES = [
  'get_child_agent_status',
  'pause_child_agent',
  'stop_child_agent',
  'message_child_agent',
] as const;

/**
 * create_agent is shown only while the agent may still create a child: its limit is above zero
 * and its direct children are fewer than the limit. A null allowance (not read, or not configured)
 * hides it.
 */
export function isCreateAgentExposed(allowance: AgentAllowance | null): boolean {
  return allowance !== null && allowance.childAgentLimit > 0 && allowance.childCount < allowance.childAgentLimit;
}

/** Creator tools are shown when the agent has at least one direct child. A null allowance hides them. */
export function isCreatorToolExposed(allowance: AgentAllowance | null): boolean {
  return allowance !== null && allowance.childCount > 0;
}

// --- Input schemas (strict: unknown keys such as creatorId, parentAgentId or depth are refused) ---

const CreateAgentParamsSchema = z.object({
  name: z.string().trim().min(1).max(100).describe('Name for the child agent'),
  prompt: z.string().trim().min(1).max(8000).describe('Goal and instructions for the child agent'),
  skillIds: z.array(z.string().min(1)).optional().describe('Skills to grant the child from your own skills. Only skills you hold can be granted.'),
  connectionIds: z.array(z.string().min(1)).optional().describe('Connections to grant the child from your own connections. Only connections you hold can be granted.'),
}).strict();

const ChildAgentIdSchema = z.object({
  agentId: z.string().min(1).max(200).describe('ID of one of your direct child agents'),
}).strict();

const PauseChildParamsSchema = ChildAgentIdSchema.extend({
  reason: z.string().min(1).max(500).optional().describe('Why the child is being paused. Recorded for audit.'),
}).strict();

const MessageChildParamsSchema = ChildAgentIdSchema.extend({
  message: z.string().min(1).max(4000).describe('Message to send to the child agent'),
}).strict();

// --- Result mapping ---

const NOT_CONFIGURED_CODE = 'agent.platform.not_configured';

function notConfigured(): ToolResult {
  return { success: false, error: 'agent platform is not configured for this agent', errorCode: NOT_CONFIGURED_CODE, retryable: false };
}

/** Maps a platform failure to a structured tool error. Only the namespaced code and fixed message leave the client. */
function platformFailure(error: AgentPlatformError): ToolResult {
  return { success: false, error: error.message, errorCode: error.code, retryable: error.retryable };
}

// --- create_agent ---

const createAgentTool: AgentTool = {
  name: CREATE_AGENT_TOOL_NAME,
  description: 'Create a child agent with its own name and prompt. You may grant it some of your skills and connections. The child starts stopped; the user starts it. Returns the new agent ID, its depth and your remaining child allowance.',
  parametersSchema: CreateAgentParamsSchema,
  parameters: convertZodToJsonSchema(CreateAgentParamsSchema),
  category: 'write-database',
  promptGuidance: 'Give the child a specific goal in prompt. Grant only the skills and connections it needs. The child cannot start until the user starts it.',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.agentPlatform) return notConfigured();
    const input = params as z.infer<typeof CreateAgentParamsSchema>;

    const created = await ctx.agentPlatform.createChildAgent(input);
    if (!created.ok) return platformFailure(created.error);

    // The create response does not carry the allowance, so a follow-up read reports what remains.
    // If that read fails, the child still exists: report the creation and leave the allowance unknown.
    const allowance = await ctx.agentPlatform.getOwnAllowance();
    return {
      success: true,
      data: {
        ok: true,
        agentId: created.data.id,
        depth: created.data.depth,
        childAgentLimit: allowance.ok ? allowance.data.childAgentLimit : null,
        remainingChildAllowance: allowance.ok ? allowance.data.remainingChildAllowance : null,
        note: 'Child agent created in stopped state. The user starts it.',
      },
    };
  },
};

// --- get_child_agent_status ---

const getChildAgentStatusTool: AgentTool = {
  name: 'get_child_agent_status',
  description: 'Get the status, runtime state and depth of one of your direct child agents.',
  parametersSchema: ChildAgentIdSchema,
  parameters: convertZodToJsonSchema(ChildAgentIdSchema),
  category: 'read-database',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.agentPlatform) return notConfigured();
    const { agentId } = params as z.infer<typeof ChildAgentIdSchema>;

    const status = await ctx.agentPlatform.getChildStatus(agentId);
    if (!status.ok) return platformFailure(status.error);
    return { success: true, data: { ok: true, child: status.data } };
  },
};

// --- pause_child_agent ---

const pauseChildAgentTool: AgentTool = {
  name: 'pause_child_agent',
  description: 'Pause one of your direct child agents. The pause is recorded as requested by you.',
  parametersSchema: PauseChildParamsSchema,
  parameters: convertZodToJsonSchema(PauseChildParamsSchema),
  category: 'write-database',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.agentPlatform) return notConfigured();
    const { agentId, reason } = params as z.infer<typeof PauseChildParamsSchema>;

    const paused = await ctx.agentPlatform.pauseChildAgent(agentId, reason);
    if (!paused.ok) return platformFailure(paused.error);
    return { success: true, data: { ok: true, agentId, status: paused.data.status } };
  },
};

// --- stop_child_agent ---

const stopChildAgentTool: AgentTool = {
  name: 'stop_child_agent',
  description: 'Stop one of your direct child agents. Same effect as the user pressing Stop.',
  parametersSchema: ChildAgentIdSchema,
  parameters: convertZodToJsonSchema(ChildAgentIdSchema),
  category: 'write-database',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.agentPlatform) return notConfigured();
    const { agentId } = params as z.infer<typeof ChildAgentIdSchema>;

    const stopped = await ctx.agentPlatform.stopChildAgent(agentId);
    if (!stopped.ok) return platformFailure(stopped.error);
    return { success: true, data: { ok: true, agentId, status: stopped.data.status } };
  },
};

// --- message_child_agent ---

const messageChildAgentTool: AgentTool = {
  name: 'message_child_agent',
  description: 'Send a message to one of your direct child agents. Messages are rate limited per pair, and replies count against the same limit.',
  parametersSchema: MessageChildParamsSchema,
  parameters: convertZodToJsonSchema(MessageChildParamsSchema),
  category: 'write-messaging',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.agentPlatform) return notConfigured();
    const { agentId, message } = params as z.infer<typeof MessageChildParamsSchema>;

    const sent = await ctx.agentPlatform.messageChildAgent(agentId, message);
    if (!sent.ok) return platformFailure(sent.error);
    return { success: true, data: { ok: true, agentId, delivered: sent.data.delivered } };
  },
};

export const agentCreationTools: AgentTool[] = [
  createAgentTool,
  getChildAgentStatusTool,
  pauseChildAgentTool,
  stopChildAgentTool,
  messageChildAgentTool,
];
