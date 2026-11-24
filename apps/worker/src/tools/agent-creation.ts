import { z } from 'zod';
import { DocumentIdsParam, isUserOnlySkill, type AgentAllowance, type AgentPlatformError, type AgentTool, type ChildAgentCreated, type ToolResult, type ToolContext } from '@herobids/domain';
import { convertZodToJsonSchema } from './registry.js';

/**
 * Agent-created agents (001-plan §8). Every tool calls the platform API as this agent. The API
 * derives lineage from the agent key, so no tool input can name a creator, parent or depth.
 */

export const CREATE_CHILD_AGENT_TOOL_NAME = 'create_child_agent';
export const LIST_OWNER_CONNECTIONS_TOOL_NAME = 'list_owner_connections';

/**
 * Creator tools act on direct children and are shown only when the agent has at least one. They are
 * also gated by the children skill, which lists them. list_child_agents is not here: it is shown with the
 * skill alone, so an agent with no children can still discover that it has none.
 */
export const CREATOR_TOOL_NAMES = [
  'get_child_agent_status',
  'pause_child_agent',
  'stop_child_agent',
  'message_child_agent',
  'delete_child_agent',
] as const;

/** The message shown when an agent asks for the user-only children skill. */
const USER_ONLY_SKILL_MESSAGE = 'This skill can only be added by the user.';

/**
 * create_child_agent is shown only while the agent may still create a child: its limit is above zero
 * and its direct children are fewer than the limit. A null allowance (not read, or not configured)
 * hides it.
 */
export function isCreateChildAgentExposed(allowance: AgentAllowance | null): boolean {
  return allowance !== null && allowance.childAgentLimit > 0 && allowance.childCount < allowance.childAgentLimit;
}

/** list_owner_connections is shown only while the user lets this agent grant any of their connections. A null allowance hides it. */
export function isListOwnerConnectionsExposed(allowance: AgentAllowance | null): boolean {
  return allowance !== null && allowance.grantAnyConnectionToChildren;
}

/** Creator tools are shown when the agent has at least one direct child. A null allowance hides them. */
export function isCreatorToolExposed(allowance: AgentAllowance | null): boolean {
  return allowance !== null && allowance.childCount > 0;
}

// --- Input schemas (strict: unknown keys such as creatorId, parentAgentId or depth are refused) ---

const CreateChildAgentParamsSchema = z.object({
  name: z.string().trim().min(1).max(100).describe('Name for the child agent'),
  prompt: z.string().trim().min(1).max(8000).describe('Goal and instructions for the child agent'),
  skillIds: z.array(z.string().min(1)).optional().describe('Skills to grant the child, by skill id or slug. Which skills are allowed depends on your grant settings: skills you hold, or any skill the user may select when the user turned on that setting. A refusal lists the missing skills; the user can assign them to you or turn on the setting.'),
  connectionIds: z.array(z.string().min(1)).optional().describe('Connection ids to grant the child. Which connections are allowed depends on your grant settings: connections you hold, or any active connection of the user when the user turned on that setting (list_owner_connections then lists them). A refusal lists the missing connections; the user can assign them to you or turn on the setting.'),
  executionDefaults: z.object({
    mode: z.enum(['paper', 'shadow']).optional().describe('Execution mode for a trading child. Defaults to paper. shadow needs a connection granted to the child. live is not supported yet.'),
    slippageBps: z.number().int().min(0).max(10000).nullable().optional().describe('Allowed slippage in basis points (1 bps = 0.01%). Omit for the platform default.'),
  }).strict().optional().describe('Execution settings for a child that holds a trading skill. Only valid for a trading child. Omit to use the defaults.'),
  start: z.boolean().default(true).describe('Start the child after it is created. Default true. Set false to create it stopped.'),
}).strict();

const ChildAgentIdSchema = z.object({
  agentId: z.string().min(1).max(200).describe('ID of one of your direct child agents'),
}).strict();

const NoParamsSchema = z.object({}).strict();

const PauseChildParamsSchema = ChildAgentIdSchema.extend({
  reason: z.string().min(1).max(500).optional().describe('Why the child is being paused. Recorded for audit.'),
}).strict();

const MessageChildParamsSchema = ChildAgentIdSchema.extend({
  message: z.string().min(1).max(4000).describe('Message to send to the child agent'),
  documentIds: DocumentIdsParam,
}).strict();

const DeleteChildParamsSchema = ChildAgentIdSchema.extend({
  stopFirst: z.boolean().default(true).describe('Stop the child first if it is running. Default true. Set false to refuse the delete while the child runs.'),
}).strict();

// --- Result mapping ---

const NOT_CONFIGURED_CODE = 'agent.platform.not_configured';

function notConfigured(): ToolResult {
  return { success: false, error: 'agent platform is not configured for this agent', errorCode: NOT_CONFIGURED_CODE, retryable: false };
}

const GRANT_NOT_HELD_CODE = 'agent.create.grant_not_held';

/** Remedy for a refused grant: the agent cannot fix it itself, so it is told who can. */
function grantNotHeldHint(context: Record<string, unknown> | undefined): string {
  const params = context?.['params'];
  const kind = params && typeof params === 'object' ? (params as Record<string, unknown>)['kind'] : undefined;
  const noun = kind === 'connection' ? 'connections' : 'skills';
  return `Ask the user to assign the missing ${noun} to you, or to turn on the setting that lets you grant ${noun} you do not hold. Do not retry with the same ${noun}.`;
}

/**
 * Maps a platform failure to a structured tool error. On a 4xx the client attaches the bounded
 * refusal detail (params such as kind and missing, validation issues); it goes into the error text
 * because the agent loop forwards only `error` and `errorCode` for a failed tool.
 */
function platformFailure(error: AgentPlatformError): ToolResult {
  const parts = [error.message];
  if (error.context) parts.push(`Details: ${JSON.stringify(error.context)}`);
  if (error.code === GRANT_NOT_HELD_CODE) parts.push(grantNotHeldHint(error.context));
  return { success: false, error: parts.join(' '), errorCode: error.code, retryable: error.retryable };
}

// --- create_child_agent ---

const createChildAgentTool: AgentTool = {
  name: CREATE_CHILD_AGENT_TOOL_NAME,
  description: 'Create a child agent with its own name and prompt. You may grant it skills and connections; which ones depends on your grant settings (see skillIds and connectionIds). If a grant is refused, report it to the user instead of retrying with other skills. The child starts by default; pass start: false to create it stopped. For a child with a trading skill, executionDefaults sets its execution mode and slippage: the child takes whatever mode you pass and defaults to paper. shadow needs a connection granted to the child. live is not supported yet. Returns the new agent ID, its depth, its status, whether it started, and your remaining child allowance. A retry with the same name within the platform window returns the existing child with duplicate: true and does not start it again.',
  parametersSchema: CreateChildAgentParamsSchema,
  parameters: convertZodToJsonSchema(CreateChildAgentParamsSchema),
  category: 'write-database',
  promptGuidance: 'Give the child a specific goal in prompt. Grant only the skills and connections it needs. Leave start at its default unless the child should wait stopped.',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.agentPlatform) return notConfigured();
    const input = params as z.infer<typeof CreateChildAgentParamsSchema>;
    if (input.skillIds?.some(isUserOnlySkill)) return userOnlySkill();

    const created = await ctx.agentPlatform.createChildAgent(input);
    if (!created.ok) return platformFailure(created.error);

    // The create response does not carry the allowance, so a follow-up read reports what remains.
    // If that read fails, the child still exists: report the creation and leave the allowance unknown.
    const allowance = await ctx.agentPlatform.getOwnAllowance();
    const { id, depth, status, duplicate, started, startError } = created.data;
    return {
      success: true,
      data: {
        ok: true,
        agentId: id,
        depth,
        status,
        duplicate,
        started,
        // The child exists even when its start is refused, so this is a success with the reason attached.
        startError: startError ? { code: startError.code, message: startError.message } : null,
        childAgentLimit: allowance.ok ? allowance.data.childAgentLimit : null,
        remainingChildAllowance: allowance.ok ? allowance.data.remainingChildAllowance : null,
        note: childCreatedNote(created.data),
      },
    };
  },
};

function childCreatedNote(created: ChildAgentCreated): string {
  if (created.duplicate) return 'A child with this name was created recently. That child is returned; no new child was created and it was not started again.';
  if (created.started) return 'Child agent created and started. A refusal of the launch later shows as lastStartRefusal in get_child_agent_status.';
  if (created.startError) return 'Child agent created but not started. It stays stopped; see startError.';
  return 'Child agent created in stopped state, because start was false.';
}

function userOnlySkill(): ToolResult {
  return { success: false, error: USER_ONLY_SKILL_MESSAGE, errorCode: 'skill.user_only', retryable: false };
}

// --- list_child_agents ---

const listChildAgentsTool: AgentTool = {
  name: 'list_child_agents',
  description: 'List your direct child agents with their ID, name, status, number of children and lastStartRefusal (why the child\'s last launch was refused, or null). Call this first to get the IDs the other child tools need. Returns an empty list when you have no children.',
  parametersSchema: NoParamsSchema,
  parameters: convertZodToJsonSchema(NoParamsSchema),
  category: 'read-database',
  async execute(_params: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.agentPlatform) return notConfigured();

    const listed = await ctx.agentPlatform.listChildAgents();
    if (!listed.ok) return platformFailure(listed.error);
    return { success: true, data: { ok: true, count: listed.data.length, children: listed.data } };
  },
};

// --- list_owner_connections ---

const listOwnerConnectionsTool: AgentTool = {
  name: LIST_OWNER_CONNECTIONS_TOOL_NAME,
  description: 'List the user\'s active connections (id, provider, status, label) that you may grant to a child through create_child_agent connectionIds. Available only when the user allowed you to grant any of their connections. Shows no credentials. A child with a trading connection can trade on that account, so grant only what the child needs.',
  parametersSchema: NoParamsSchema,
  parameters: convertZodToJsonSchema(NoParamsSchema),
  category: 'read-database',
  async execute(_params: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.agentPlatform) return notConfigured();

    const listed = await ctx.agentPlatform.listOwnerConnections();
    if (!listed.ok) return platformFailure(listed.error);
    // Re-picked by field so nothing beyond id, provider, status and label can reach the agent.
    const connections = listed.data.map(({ id, provider, status, label }) => ({ id, provider, status, label }));
    return { success: true, data: { ok: true, count: connections.length, connections } };
  },
};

// --- get_child_agent_status ---

const getChildAgentStatusTool: AgentTool = {
  name: 'get_child_agent_status',
  description: 'Get the status, runtime state, depth and lastStartRefusal (why the child\'s last launch was refused, or null) of one of your direct child agents.',
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

// --- delete_child_agent ---

/** Namespaced platform codes that have a clearer message for the agent than the generic platform one. */
const DELETE_CHILD_MESSAGES: Record<string, string> = {
  'agent.child.has_children': 'This child agent has children of its own. Ask the user to delete it.',
  'agent.child.running': 'child is running; stop it first or pass stopFirst: true',
};

const deleteChildAgentTool: AgentTool = {
  name: 'delete_child_agent',
  description: 'Permanently delete one of your direct child agents. The child must have no children of its own. By default a running child is stopped first; pass stopFirst: false to refuse the delete while it runs. Deletion cannot be undone.',
  parametersSchema: DeleteChildParamsSchema,
  parameters: convertZodToJsonSchema(DeleteChildParamsSchema),
  category: 'write-database',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.agentPlatform) return notConfigured();
    const { agentId, stopFirst } = params as z.infer<typeof DeleteChildParamsSchema>;

    // The platform checks the child's state and, when stopFirst is set, stops it before the delete.
    const deleted = await ctx.agentPlatform.deleteChildAgent(agentId, stopFirst);
    if (!deleted.ok) {
      const message = DELETE_CHILD_MESSAGES[deleted.error.code];
      return message
        ? { success: false, error: message, errorCode: deleted.error.code, retryable: false }
        : platformFailure(deleted.error);
    }
    return { success: true, data: { ok: true, agentId, deleted: true, stopped: deleted.data.stopped } };
  },
};

// --- message_child_agent ---

const messageChildAgentTool: AgentTool = {
  name: 'message_child_agent',
  description: 'Send your instruction or direction to one of your direct child agents. The child treats it as authority from its creator. Use message_peer_agent for collaboration or a second opinion, which carries no authority. Messages you send are rate limited per parent-child pair. Set documentIds (up to 3, from list_agent_documents or a document notice you received) to attach documents you hold: the recipient agent receives an independent copy.',
  parametersSchema: MessageChildParamsSchema,
  parameters: convertZodToJsonSchema(MessageChildParamsSchema),
  category: 'write-messaging',
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.agentPlatform) return notConfigured();
    const { agentId, message, documentIds } = params as z.infer<typeof MessageChildParamsSchema>;

    const sent = await ctx.agentPlatform.messageChildAgent(agentId, message, documentIds);
    if (!sent.ok) return platformFailure(sent.error);
    return { success: true, data: { ok: true, agentId, delivered: sent.data.delivered } };
  },
};

export const agentCreationTools: AgentTool[] = [
  createChildAgentTool,
  listChildAgentsTool,
  listOwnerConnectionsTool,
  getChildAgentStatusTool,
  pauseChildAgentTool,
  stopChildAgentTool,
  messageChildAgentTool,
  deleteChildAgentTool,
];
