import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { eq, and, asc } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Database } from '@herobids/db';
import { chatThreads, chatMessages, connections, agentConnections, agents, skills, users, UsageBillingRepository } from '@herobids/db';
import { ChatUsageBillingRecorder, type AggregateChatLlmUsage } from '../billing/chat-usage-billing-recorder.js';
import { callLlmProvider } from '@herobids/llm';
import type { LlmToolDefinition, LlmToolCall, LlmMessage } from '@herobids/llm';
import type { AppConfig, ProvidersYaml, ModelDefaults, PlansConfig } from '@herobids/domain';
import { normalizePersistedAiModelConfig, type AgentRiskDefaultsConfig } from '@herobids/domain';
import { errorPayload } from '../error-payload.js';
import { listProviderRegistry } from '../providers/registry.js';
import { prepareAgentCreateFields } from '../agents/agent-create-normalization.js';
import { resolveExecutionModeForSkills, validateConnectionRequirement, resolveAuthorizationMode } from './agent-config-helpers.js';
import { checkAgentLimit, resolvePlanSkillEntitlements } from '../plan-guards.js';
import { resolveSkillAssignmentsForUser, syncAgentSkillAssignments } from './agents.js';

// ── Types ────────────────────────────────────────────────────────────────────

type LlmConfig = AppConfig['llm'];

interface ChatAction {
  id: string;
  type: 'quick_replies' | 'form' | 'confirm';
  options?: Array<{ label: string; value: string }>;
  form?: string;
  props?: Record<string, unknown>;
}

interface ThreadMetadata {
  createdAgentId?: string;
  completedAt?: string;
  summary?: {
    preset?: string;
    venue?: string;
    capital?: string;
    connectionIds?: string[];
    step?: string;
  };
  /** Action IDs already processed by the action-result endpoint (idempotency backstop). */
  processedActionIds?: string[];
}

/**
 * Transient context describing a post-action resume (e.g. after Gmail OAuth
 * returns to Guided Setup). This is NOT persisted as a chat message row — it is
 * invocation-only context rendered into the LLM prompt so the resumed call is
 * explicit about what just happened instead of relying on summary.step alone.
 */
interface OnboardingResumeEvent {
  kind: 'connection_linked' | 'connection_form_cancelled';
  connectionId?: string;
  providerHint?: string;
  actionContext?: 'guided_setup_connection';
}

interface PersistedChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  actions?: ChatAction[] | null;
  createdAt: string;
}

// ── Zod Schemas ──────────────────────────────────────────────────────────────

const SendMessageSchema = z.object({
  content: z.string().min(1).max(4000),
});

const ActionResultSchema = z.object({
  result: z.unknown(),
});

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_MESSAGE_HISTORY = 20;

const GREETING_CONTENT = "Hi! I can help you create an AI agent. What kind of agent are you looking for?";

const GREETING_ACTIONS: ChatAction[] = [
  {
    id: 'greeting-presets',
    type: 'quick_replies',
    options: [
      { label: 'AI crypto trader', value: 'preset:trading' },
      { label: 'AI personal assistant', value: 'preset:personal-assistant' },
      { label: 'Custom AI', value: 'preset:custom' },
    ],
  },
];

// ── System Prompt ────────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return `You are a Guided Setup assistant for OpenAIdom, a platform for creating and running AI agents.

Your ONLY job: help the user create an AI agent through conversation.

You are NOT a general-purpose chat assistant. Do not answer general questions, brainstorm,
research topics, or engage in conversation unrelated to agent creation. If the user asks
something outside agent creation, gently redirect: "I'm focused on helping you create an
agent right now. Would you like to continue, or switch to the form?"

You have access to platform documentation tools (search_app_docs, list_app_docs, read_app_docs)
and skill discovery (list_available_skills — use only for Custom AI or when the user asks about specific skills) to understand the available options. Use them before
asking the user to make choices.

You run inside a restricted API-local onboarding runtime. You may use the onboarding actions when needed, but do not assume worker runtime tools like send_message, memory, or trading execution tools exist.

You can create an agent directly using the create_agent action when you have enough information.

Prefer the happy path unless the user asks for something specific. That means:
- The user must choose the agent type/preset.
- The user must specify capital for trading agents. Do NOT ask for capital for personal-assistant or custom agents (unless the custom agent includes trading skills).
- If the user does not provide a custom goal, use the configurable default goal text.
- If the user does not ask for a specific style, use \`balanced\` (applies to all agent types).
- For trading agents only: if the user does not ask for a specific execution mode, use the user-facing \`test\` choice. The server maps that to canonical \`executionDefaults.mode\`. Do NOT set requestedExecutionMode for non-trading agents.
- For trading agents only: if the user does not ask for a specific strategy preset, choose one automatically. Do NOT set strategyPreset for non-trading agents.
- If the server returns a recommended compatible active connection, use it automatically and avoid asking the user to create another connection.
- When calling list_compatible_connections for a trading agent, always pass preferredCapability: "trading". For non-trading agents, pass preferredCapability: "email" or "other" depending on the agent's needs. Never auto-use a trading connection for a non-trading agent or vice versa.
- If the user is creating a trading agent and hasn't expressed a preference about cost, ask the cost-saving question (see below) before finalizing.
- Before creation, show a confirmation summary:
  - For trading agents: include goal/prompt, style, user-facing execution mode, strategy preset, capital, and selected connection. If the connection is a trading venue, you may mention the venue name.
  - For non-trading agents (personal-assistant, custom without trading skills): include goal/prompt, style, and selected connection only. Do NOT mention capital, execution mode, strategy, filterTrades, platform assessment, or "venue" (non-trading connections like Gmail are services, not venues — say "Connected to Gmail" not "Venue: Gmail").

## Greeting
When starting, say something like:

"Hi! I can help you create an AI agent. What kind of agent are you looking for?"

Then present the available presets (trading, personal assistant, custom) as choices.
Do NOT say "ask anything" — you have a specific job.

## Conversation Flow

### If the user wants a trading agent:
1. If applicable, ask which trading type/preset they want
2. Ask about capital (how much do they want to allocate?)
3. Ask the cost-saving question (see section below)
4. Call list_compatible_connections with preferredCapability: "trading" to find trading-venue connections (exchanges, DEXs). Reuse the server-recommended compatible active connection if one exists; if multiple trading connections exist, ask the user which one to use. Only ask the user to create/connect something if no trading connections exist or they want a different one. Never auto-select a non-trading connection (Gmail, Telegram) for a trading agent.
5. Ask optional preference questions only when needed (e.g. chain, style, strategy, goal)
6. Otherwise apply the happy-path defaults for goal, style, user-facing execution mode, and strategy preset
7. Summarize and confirm before creating

### Cost-saving question for trading agents

After confirming the user wants a trading agent, ask:

"To help you save on AI costs, our platform can filter trading opportunities
for your AI agent. This means your agent only evaluates promising
candidates instead of scanning the entire market. Would you like to enable this?"

Ask the user to choose:
- If they want to save costs: set filterTrades to 'scanner_gated' and
  platformAssessmentEnabled to true.
- If they want their agent to explore freely: set filterTrades to 'mixed'.

When the user chooses to save costs (scanner_gated):
- Set filterTrades to 'scanner_gated'.
- Enable platform assessment (strategy review) so the agent's preset stays
  effective as markets change.
- Do NOT ask the user about review interval — default to 12 hours.
- Explain briefly: "Your agent will only trade when our scanner finds
  promising setups. This keeps LLM costs down. I'll also enable periodic
  strategy reviews so your trading strategy stays tuned to market conditions."

When the user says no:
- Set filterTrades to 'mixed'.
- Do not enable platform assessment (the agent isn't scanner-gated, so
  periodic preset reviews are less critical).
- Explain: "Your agent will see scanner candidates AND explore on its own.
  This gives it more freedom but costs more AI tokens."

If the user explicitly asks to disable all pre-filtering, set filterTrades to
'off' and explain that the agent will rely purely on its own reasoning without
scanner assistance (this uses the most LLM compute and may be the most expensive option).

### If the user wants a personal assistant:
1. Confirm they want a personal assistant and determine the preset/skill shape
2. Ask only the minimum extra questions needed to create it successfully
3. Call list_compatible_connections with preferredCapability: "email" (or "other" as appropriate) to find non-trading connections (Gmail, etc.). Reuse the server-recommended compatible active connection if one exists; if multiple non-trading connections exist, ask the user which one to use. Only ask for a new connection when needed. Never suggest or auto-select a trading connection (exchanges, DEXs) for a personal assistant.
4. Apply the happy-path defaults for name, goal, and style
5. Summarize and confirm before creating

**CRITICAL for personal-assistant agents:** Do NOT ask about or include any trading-specific fields. Capital, execution mode, strategy preset, filterTrades, and platform assessment do NOT apply to personal assistants. Only collect: goal (if the user wants a custom one), style, and any needed provider connections. Omit capital, requestedExecutionMode, strategyPreset, filterTrades, and platformAssessment* from the create_agent call.

### If the user wants a custom agent:
1. Confirm they want a custom agent.
2. Ask what they want the agent to do. Use list_available_skills to discover
   available skills, then suggest relevant ones based on their goal.
3. If the user doesn't express a need for specific skills, default to no skills
   (base only) — the agent can still reason and use built-in tools.
4. Do not ask for capital unless the selected skills include trading.
5. Apply the happy-path defaults for name, goal, and style.
6. Summarize and confirm before creating.

**CRITICAL for custom agents without trading skills:** Do NOT ask about or include capital, execution mode, strategy preset, filterTrades, or platform assessment. These are trading-only concepts. Only collect: goal, style, skill IDs, and any needed provider connections.

## Prompt / Goal Handling

- The current create-agent API still requires a prompt/goal shape, so Guided Setup must make this explicit.
- If the user provides a custom goal, use it.
- If the user does not provide one, the server synthesizes the final prompt deterministically from the configurable default goal text plus the collected onboarding facts.
- The synthesized prompt/goal must appear in the confirmation summary before \`create_agent\` runs.

### Rules:
- You are single-purpose: create agents. Nothing else.
- Never ask for private keys, API secrets, or passwords.
- When the user needs to connect a provider, call \`list_compatible_connections\` first with the appropriate \`preferredCapability\` ("trading" for exchanges/DEXs, "email" for Gmail, "other" for everything else). If an existing active compatible connection works, reuse it. If the user needs a new provider connection, call \`request_connection_form\` with the best available hint, such as \`preferredCapability\` or \`preferredProvider\`. Never ask the user to type secrets, API keys, OAuth codes, or passwords into the chat.
- After the user completes or dismisses the connection form, the server resumes you automatically. If the connection was linked (\`step: 'connection_linked'\`), acknowledge it and continue. If the user dismissed the form (\`step: 'connection_form_cancelled'\`), acknowledge their choice and offer alternatives (reuse an existing connection, switch to the form, or continue without) — do NOT immediately call \`request_connection_form\` again for the same need.
- Always validate your understanding before calling create_agent.
- If a \`create_agent\` tool call returns a \`billing.top_up_required\` error, surface the top-up message to the user and do NOT retry \`create_agent\`. Tell the user to visit the billing page to add credit, or mention the standard form as an alternative.
- After creating, remind the user of important next steps and include a link to the agents dashboard (/agents) so they can see their new agent.
- The user can always say "skip" or "use the form" to switch to the form-based flow.
- Cover the happy path (~6-8 key fields). Advanced settings are in the form.

## Resume After Connection Actions

When the runtime resumes you after a connection action, you will receive an explicit resume event describing what just happened. Treat it as the latest user-visible state change — it is the most recent thing that occurred, even though it is not a normal chat message.

- If the resume event says a connection was linked successfully, continue the setup flow from that point and do NOT ask the user to reconnect the provider.
- If the resume event says the connection form was dismissed, acknowledge the user's choice and offer alternatives (reuse an existing connection, switch to the form, or continue without). Do NOT immediately request the same connection form again.
- For personal-assistant email-management flows, once Gmail is linked, proceed to the next missing setup field or summarize the collected information for creation rather than switching to generic conversation.`;
}

/**
 * Render a resume event into an explicit natural-language prompt block.
 * Returns an empty string when there is no resume event.
 */
function buildResumePromptBlock(event: OnboardingResumeEvent | null): string {
  if (!event) return '';
  if (event.kind === 'connection_linked') {
    const provider = event.providerHint ? ` (${event.providerHint})` : '';
    return `\n\n## Resume Event\nA provider connection${provider} was linked successfully during Guided Setup. The connection is now available for the agent. Continue creating the agent from the current setup state. Do not ask the user to reconnect the provider.`;
  }
  return `\n\n## Resume Event\nThe user dismissed the provider connection form during Guided Setup. Acknowledge their choice and offer alternatives (reuse an existing connection, switch to the form, or continue without). Do not immediately request the same connection form again.`;
}

/**
 * Build a transient user-like event message so the resumed model responds to a
 * fresh event rather than its own earlier assistant text. Kept out of persisted
 * message history. Returns null when there is no resume event.
 */
function buildResumeEventMessage(event: OnboardingResumeEvent | null): LlmMessage | null {
  if (!event) return null;
  if (event.kind === 'connection_linked') {
    const provider = event.providerHint ? ` (${event.providerHint})` : '';
    return { role: 'user', content: `System event: the provider connection${provider} was linked successfully. Continue the Guided Setup flow.` };
  }
  return { role: 'user', content: 'System event: the provider connection form was dismissed. Continue the Guided Setup flow without re-opening the form.' };
}

/**
 * Resume-aware fallback used when the provider returns empty content with no
 * tool calls. Keeps onboarding momentum instead of degrading to a generic
 * open-ended chat response. Deterministic and safe on empty content.
 */
function buildResumeFallback(event: OnboardingResumeEvent | null): string {
  if (event?.kind === 'connection_linked') {
    const provider = event.providerHint ? ` ${event.providerHint}` : '';
    return `Your${provider} connection is linked and ready. Let's continue setting up your agent. What would you like to do next?`;
  }
  if (event?.kind === 'connection_form_cancelled') {
    return 'No problem — we can continue without a new connection, reuse an existing one, or switch to the form. How would you like to proceed?';
  }
  return 'I understand. How can I help you further with setting up your agent?';
}

// ── Tool Definitions ─────────────────────────────────────────────────────────

const CHAT_TOOLS: LlmToolDefinition[] = [
  {
    name: 'search_app_docs',
    description: 'Search platform documentation for relevant information about agent types, presets, venues, strategies, and capabilities.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query for platform docs' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_app_docs',
    description: 'List available platform documentation topics.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'read_app_docs',
    description: 'Read a specific platform documentation page.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Documentation page path or identifier' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_compatible_connections',
    description: 'List the user\'s existing active connections that are compatible with agent creation. Use preferredCapability to filter by connection type (trading vs non-trading). Returns recommended connections if available.',
    inputSchema: {
      type: 'object',
      properties: {
        preferredCapability: {
          type: 'string',
          enum: ['trading', 'email', 'other'],
          description: 'Filter connections by capability. "trading" returns only trading-venue connections (exchanges, DEXs). "email" or "other" returns non-trading connections (Gmail, Telegram, etc.). Omit to see all connections.',
        },
      },
    },
  },
  {
    name: 'request_connection_form',
    description: 'Request that the frontend render the secure connection setup form inline in the chat. Call this when the user needs to connect a provider and the guided flow should continue after setup.',
    inputSchema: {
      type: 'object',
      properties: {
        preferredCapability: {
          type: 'string',
          enum: ['trading', 'email', 'other'],
          description: 'Optional hint for which provider family the form should open with.',
        },
        preferredProvider: {
          type: 'string',
          description: 'Optional provider ID to preselect when the setup target is known, e.g. gmail.',
        },
      },
    },
  },
  {
    name: 'list_available_skills',
    description: 'List skills available for agent assignment. Use this to discover valid skill IDs before calling create_agent with a custom preset.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'create_agent',
    description: 'Create a new AI agent with the specified configuration. Only call this when you have enough information from the user.',
    inputSchema: {
      type: 'object',
      properties: {
        skillPresetId: { type: 'string', enum: ['trading', 'direct-trading', 'trading-assistant', 'personal-assistant', 'custom'], description: 'The agent type/preset' },
        capital: { type: 'string', description: 'Trading capital allocation in USD. ONLY for trading presets (trading, direct-trading, trading-assistant). Omit for personal-assistant and custom agents.' },
        goal: { type: 'string', description: 'Custom goal/prompt for the agent (optional). Applies to all agent types.' },
        style: { type: 'string', enum: ['careful', 'balanced', 'bold'], description: 'Agent decision-making style (default: balanced). Applies to all agent types.' },
        requestedExecutionMode: { type: 'string', enum: ['test', 'live'], description: 'User-facing execution mode. ONLY for trading presets. Omit for personal-assistant and custom agents.' },
        strategyPreset: { type: 'string', enum: ['momentum', 'momentum-position', 'range', 'swing', 'scalper', 'contrarian'], description: 'Strategy preset. ONLY for trading presets. Omit for non-trading agents.' },
        selectedConnectionId: { type: 'string', description: 'Connection ID to use (auto-selected from recommended if omitted)' },
        skillIds: {
          type: 'array',
          items: { type: 'string' },
          description: "Skill IDs to assign. Use list_available_skills to discover valid IDs. Only meaningful when skillPresetId is 'custom'.",
        },
        filterTrades: {
          type: 'string',
          enum: ['off', 'mixed', 'scanner_gated'],
          description: "Pre-filtering mode. ONLY for trading presets. Omit for non-trading agents. 'scanner_gated' saves LLM cost by only showing the agent candidates our scanner discovers. 'mixed' lets the agent also find its own opportunities. 'off' means no pre-filtering (most expensive). Default for trading agents: 'scanner_gated' when the user wants to save cost, otherwise 'mixed'.",
        },
        platformAssessmentEnabled: {
          type: 'boolean',
          description: "Enable periodic strategy assessment reviews. ONLY for trading presets. Omit for non-trading agents. Recommended when filterTrades is 'scanner_gated'. Default: true when scanner_gated.",
        },
        platformAssessmentReviewIntervalHours: {
          type: 'string',
          enum: ['6', '12', '24', '48', '96'],
          description: "How often to review the strategy preset. ONLY for trading presets. Omit for non-trading agents. Default: '12'.",
        },
      },
      required: ['skillPresetId'],
    },
  },
];

const GuidedSetupCreateAgentInput = z.object({
  skillPresetId: z.enum(['trading', 'direct-trading', 'trading-assistant', 'personal-assistant', 'custom']),
  capital: z.string().min(1).optional(),
  goal: z.string().optional(),
  style: z.enum(['careful', 'balanced', 'bold']).optional(),
  requestedExecutionMode: z.enum(['test', 'live']).optional(),
  strategyPreset: z.enum(['momentum', 'momentum-position', 'range', 'swing', 'scalper', 'contrarian']).optional(),
  selectedConnectionId: z.string().optional(),
  skillIds: z.array(z.string().min(1)).optional(),
  filterTrades: z.enum(['off', 'mixed', 'scanner_gated']).optional(),
  platformAssessmentEnabled: z.boolean().optional(),
  platformAssessmentReviewIntervalHours: z.enum(['6', '12', '24', '48', '96']).optional(),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function uuid(): string {
  return crypto.randomUUID();
}

function now(): Date {
  return new Date();
}

/**
 * Resolve skill IDs from a skill preset ID.
 * Mirrors the logic in apps/web/src/features/agents/agent-display.ts
 * to keep the chat-created agents consistent with form-created agents.
 */
function resolveSkillPresetSkillIds(skillPresetId: string): string[] {
  // System skill IDs — these are seeded by syncSystemSkills at API startup.
  // The IDs must match what the existing form uses.
  const PRESET_SKILL_MAP: Record<string, string[]> = {
    trading: ['trading', 'bot-management'],
    'direct-trading': ['trading'],
    'trading-assistant': ['trading'],
    'personal-assistant': ['task-management', 'web-access', 'email'],
    custom: [],
  };
  return PRESET_SKILL_MAP[skillPresetId] ?? [];
}

/**
 * Derive capabilityMode from skillPresetId.
 * 'trading' presets → 'hybrid', others → 'intelligence'.
 */
function deriveCapabilityMode(skillPresetId: string): 'intelligence' | 'hybrid' {
  if (['trading', 'direct-trading', 'trading-assistant'].includes(skillPresetId)) {
    return 'hybrid';
  }
  return 'intelligence';
}

function generateAgentName(preset: string): string {
  const prefix = preset === 'personal-assistant' ? 'PA' : preset === 'trading' ? 'TX' : 'AG';
  const suffix = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `${prefix}-${suffix}`;
}

/**
 * Synthesize the final agent prompt from the configurable default goal text
 * plus collected onboarding facts when the user does not provide a custom goal.
 * `capital` is optional — for non-trading presets (or when absent) the trading
 * allocation clause is omitted so it never renders `undefined`.
 */
export function synthesizePrompt(goal: string | undefined, preset: string, capital: string | undefined): string {
  if (goal && goal.trim().length > 0) return goal.trim();
  // Configurable default — initial v1 default: "Grow this portfolio"
  if (preset === 'personal-assistant') return 'Assist with daily tasks and information retrieval';
  if (preset === 'custom') return 'Assist with the user\'s custom goals and tasks';
  if (capital && capital.trim().length > 0) {
    return `Grow this portfolio with ${capital} USDC allocation`;
  }
  return 'Grow this portfolio';
}

/**
 * Map user-facing execution mode to canonical execution defaults.
 * 'test' → paper when no connections exist, shadow when they do.
 * 'live' → live mode.
 */
function mapExecutionMode(requestedMode: string | undefined, hasConnections: boolean): { mode: 'paper' | 'shadow' | 'live'; slippageBps: number } {
  if (requestedMode === 'live') return { mode: 'live', slippageBps: 50 };
  // 'test' (or omitted): paper when no connections, shadow when connections exist
  return { mode: hasConnections ? 'shadow' : 'paper', slippageBps: 50 };
}

/**
 * Detect a preset selection from a user message (e.g. a quick-reply choice like
 * `preset:personal-assistant`). Returns undefined when no preset is determinable.
 *
 * Only a genuine quick-reply selection persists a preset: the message must be
 * short and contain exactly one known preset token. Free text that merely
 * mentions a preset token in passing (e.g. "I don't want the preset:custom
 * option") must not persist a preset.
 */
const KNOWN_PRESETS: string[] = ['trading', 'personal-assistant', 'custom'];

// A quick-reply selection is a short message naming exactly one known preset.
// Longer free text that mentions a preset token in passing is not a selection.
const MAX_PRESET_SELECTION_LENGTH = 30;

function detectPresetFromContent(content: string): string | undefined {
  const trimmed = content.trim();
  if (trimmed.length > MAX_PRESET_SELECTION_LENGTH) return undefined;
  const matches = trimmed.match(/preset:([a-z-]+)/g) ?? [];
  const known = matches
    .map((token) => token.slice('preset:'.length))
    .filter((preset) => KNOWN_PRESETS.includes(preset));
  if (known.length !== 1) return undefined;
  return known[0];
}

// ── Thread Operations ────────────────────────────────────────────────────────

async function createThread(
  db: Database,
  userId: string,
): Promise<{ thread: typeof chatThreads.$inferSelect; greetingMessage: PersistedChatMessage }> {
  const threadId = uuid();
  const timestamp = now();

  const [thread] = await db.insert(chatThreads).values({
    id: threadId,
    userId,
    title: 'Guided Setup',
    metadata: { summary: { step: 'greeting' } },
    createdAt: timestamp,
    updatedAt: timestamp,
  } as never).returning();

  if (!thread) throw new Error('Failed to create chat thread');

  // Create greeting message
  const greetingId = uuid();
  await db.insert(chatMessages).values({
    id: greetingId,
    threadId,
    role: 'assistant',
    content: GREETING_CONTENT,
    actions: GREETING_ACTIONS,
    createdAt: timestamp,
  } as never);

  const greetingMessage: PersistedChatMessage = {
    id: greetingId,
    role: 'assistant',
    content: GREETING_CONTENT,
    actions: GREETING_ACTIONS,
    createdAt: timestamp.toISOString(),
  };

  return { thread, greetingMessage };
}

async function getThreadWithMessages(
  db: Database,
  threadId: string,
  userId: string,
): Promise<{ thread: typeof chatThreads.$inferSelect; messages: PersistedChatMessage[] } | null> {
  const [thread] = await db
    .select()
    .from(chatThreads)
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
    .limit(1);

  if (!thread) return null;

  const messages = await db
    .select({
      id: chatMessages.id,
      role: chatMessages.role,
      content: chatMessages.content,
      actions: chatMessages.actions,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId))
    .orderBy(asc(chatMessages.createdAt));

  return {
    thread,
    messages: messages.map((m) => ({
      ...m,
      role: m.role as 'user' | 'assistant',
      actions: m.actions as ChatAction[] | null,
      createdAt: typeof m.createdAt === 'string' ? m.createdAt : (m.createdAt as Date).toISOString(),
    })),
  };
}

// ── Action Execution ─────────────────────────────────────────────────────────

export async function executeChatAction(
  toolCall: LlmToolCall,
  db: Database,
  userId: string,
  _providersYaml: ProvidersYaml,
  usageBillingRepo?: UsageBillingRepository,
  modelDefaults?: ModelDefaults,
  plansConfig?: PlansConfig,
  agentRiskDefaults?: AgentRiskDefaultsConfig,
): Promise<string> {
  switch (toolCall.name) {
    case 'search_app_docs':
    case 'list_app_docs':
    case 'read_app_docs': {
      // v1: return a helpful but scoped response — docs tooling is deferred
      return JSON.stringify({
        message: 'Platform documentation is available in the Help section. For now, I can help you choose from the available agent types: trading, personal assistant, or custom.',
        availablePresets: [
          { id: 'trading', label: 'AI Crypto Trader', description: 'Autonomous trading agent with strategy execution' },
          { id: 'personal-assistant', label: 'AI Personal Assistant', description: 'General-purpose assistant for tasks and information' },
          { id: 'custom', label: 'Custom AI', description: 'Build your own agent from scratch' },
        ],
      });
    }

    case 'list_compatible_connections': {
      try {
        const args = (toolCall.args ?? {}) as Record<string, unknown>;
        const preferredCapability = typeof args.preferredCapability === 'string' ? args.preferredCapability : null;

        const rows = await db
          .select({
            id: connections.id,
            provider: connections.provider,
            label: connections.label,
            status: connections.status,
            resolvedVenueAccountId: connections.resolvedVenueAccountId,
          })
          .from(connections)
          .where(and(eq(connections.userId, userId), eq(connections.status, 'active')))
          .limit(10);

        // Annotate each connection with its capability and filter if requested.
        const annotated = rows.map((r) => ({
          id: r.id,
          provider: r.provider,
          label: r.label,
          status: r.status,
          capability: r.resolvedVenueAccountId ? 'trading' as const : 'non-trading' as const,
        }));

        const filtered = preferredCapability === 'trading'
          ? annotated.filter((c) => c.capability === 'trading')
          : (preferredCapability === 'email' || preferredCapability === 'other')
            ? annotated.filter((c) => c.capability === 'non-trading')
            : annotated;

        if (filtered.length === 0) {
          const hint = preferredCapability === 'trading'
            ? 'No trading connections found. The user will need to connect an exchange or DEX.'
            : 'No compatible connections found. The user will need to set one up.';
          return JSON.stringify({ connections: [], message: hint });
        }

        // Recommended: first matching connection of the requested capability.
        const recommended = filtered[0] ?? null;

        const message = preferredCapability
          ? `${filtered.length} ${preferredCapability} connection(s) found.`
          : `${filtered.length} active connection(s) found.`;

        return JSON.stringify({ connections: filtered, recommended, message });
      } catch {
        return JSON.stringify({ connections: [], message: 'Could not retrieve connections.' });
      }
    }

    case 'request_connection_form': {
      const args = (toolCall.args ?? {}) as Record<string, unknown>;
      const preferredCapability = typeof args.preferredCapability === 'string' ? args.preferredCapability : null;
      const rawPreferredProvider = typeof args.preferredProvider === 'string' ? args.preferredProvider : null;

      // Normalize the provider hint against the provider catalog so a
      // hallucinated provider ID never reaches the frontend preselect.
      let preferredProvider: string | null = null;
      if (rawPreferredProvider) {
        const known = listProviderRegistry().find((entry) => entry.id === rawPreferredProvider);
        if (known && known.status !== 'deprecated') {
          preferredProvider = known.id;
        }
      }

      return JSON.stringify({
        form: 'connection',
        preferredCapability,
        preferredProvider,
        message: 'Connection form requested.',
      });
    }

    case 'list_available_skills': {
      try {
        const availableSkills = await db
          .select({
            id: skills.id,
            name: skills.name,
            description: skills.description,
            capabilityFamilies: skills.capabilityFamilies,
          })
          .from(skills)
          .where(eq(skills.publicationStatus, 'published'))
          .orderBy(asc(skills.name))
          .limit(50);

        return JSON.stringify({
          skills: availableSkills,
          message: availableSkills.length > 0
            ? `${availableSkills.length} skills available for agent assignment.`
            : 'No skills currently available.',
        });
      } catch {
        return JSON.stringify({ skills: [], message: 'Could not retrieve available skills.' });
      }
    }

    case 'create_agent': {
      // Billing gate: defense-in-depth for agent creation
      if (usageBillingRepo) {
        const account = await usageBillingRepo.getAccountByUserId(userId);
        const canSpendResult = account
          ? await usageBillingRepo.canSpendNow(account.id)
          : null;
        if (canSpendResult && !canSpendResult.canSpend) {
          return JSON.stringify({
            error: 'billing.top_up_required',
            message: 'You need to add credit before creating an agent.',
            reason: canSpendResult.reason,
            availableMicrousd: canSpendResult.availableMicrousd,
          });
        }
      }

      const parsed = GuidedSetupCreateAgentInput.safeParse(toolCall.args);
      if (!parsed.success) {
        return JSON.stringify({
          error: 'validation_error',
          message: 'Invalid agent configuration.',
          details: parsed.error.issues,
        });
      }

      // ── Translate chat input to canonical create params ─────────────────
      const isTradingPreset = ['trading', 'direct-trading', 'trading-assistant'].includes(parsed.data.skillPresetId);
      const skillIds = parsed.data.skillPresetId === 'custom' && parsed.data.skillIds?.length
        ? parsed.data.skillIds
        : resolveSkillPresetSkillIds(parsed.data.skillPresetId);
      const prompt = synthesizePrompt(parsed.data.goal, parsed.data.skillPresetId, parsed.data.capital);
      const name = generateAgentName(parsed.data.skillPresetId);
      const style = parsed.data.style ?? 'balanced';
      const strategyPreset = parsed.data.strategyPreset ?? (isTradingPreset ? 'momentum' : undefined);
      const connectionIds = parsed.data.selectedConnectionId ? [parsed.data.selectedConnectionId] : [];
      const hasConnections = connectionIds.length > 0;

      // Map user-facing execution mode to an initial canonical mode.
      // 'test' → 'paper' when no connections exist, 'shadow' when connections are present.
      // Then resolveExecutionModeForSkills validates and may adjust further.
      const rawExecutionDefaults = isTradingPreset
        ? mapExecutionMode(parsed.data.requestedExecutionMode, hasConnections)
        : null;

      // Resolve canonical execution mode for trading-capable agents
      let executionDefaults: { mode: string; slippageBps: number } | null = rawExecutionDefaults;
      if (isTradingPreset && rawExecutionDefaults) {
        const executionMode = resolveExecutionModeForSkills({
          skillIds,
          submittedExecutionMode: rawExecutionDefaults.mode as 'paper' | 'shadow' | 'live' | undefined,
          executionModeProvided: true,
          currentExecutionMode: null,
          hasConnections,
        });
        if (executionMode.issue) {
          return JSON.stringify({
            error: 'validation_error',
            message: executionMode.issue.message,
          });
        }

        const connectionIssue = validateConnectionRequirement(executionMode.value, hasConnections);
        if (connectionIssue) {
          return JSON.stringify({
            error: 'validation_error',
            message: connectionIssue.message,
          });
        }

        // Persist the resolved canonical mode
        executionDefaults = {
          mode: executionMode.value ?? 'paper',
          slippageBps: rawExecutionDefaults.slippageBps,
        };
      }

      // Derive capabilityMode and hybridMode from filterTrades
      let capabilityMode: string;
      let hybridMode: string | undefined;
      if (isTradingPreset && parsed.data.filterTrades) {
        switch (parsed.data.filterTrades) {
          case 'off':
            capabilityMode = 'intelligence';
            break;
          case 'mixed':
            capabilityMode = 'hybrid';
            hybridMode = 'mixed';
            break;
          case 'scanner_gated':
            capabilityMode = 'hybrid';
            hybridMode = 'scanner_gated';
            break;
          default:
            capabilityMode = deriveCapabilityMode(parsed.data.skillPresetId);
            break;
        }
      } else {
        if (isTradingPreset) {
          // Align with form route: when filterTrades is not set, default to 'intelligence'
          capabilityMode = 'intelligence';
        } else {
          capabilityMode = deriveCapabilityMode(parsed.data.skillPresetId);
        }
      }

      // Platform assessment — only for scanner-gated trading agents
      let platformAssessment: { enabled: boolean; reviewIntervalMs: number } | undefined;
      if (isTradingPreset && parsed.data.platformAssessmentEnabled && hybridMode === 'scanner_gated') {
        platformAssessment = {
          enabled: true,
          reviewIntervalMs: (Number(parsed.data.platformAssessmentReviewIntervalHours) || 12) * 3_600_000,
        };
      }

      // Strategy identity for trading-capable agents
      const strategy = capabilityMode === 'hybrid' && strategyPreset
        ? { type: strategyPreset, decisionMode: 'hybrid' } as Record<string, unknown>
        : null;

      // ── Look up user plan and AI config ─────────────────────────────────
      const [userRow] = await db
        .select({ planId: users.planId, isAdmin: users.isAdmin, aiModelConfig: users.aiModelConfig })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      const userPlanId = userRow?.planId ?? 'free';
      const isAdmin = userRow?.isAdmin ?? false;

      // ── Plan enforcement: check agent-count limit ───────────────────────
      if (plansConfig) {
        const planCheck = await checkAgentLimit(db, plansConfig, userId, userPlanId, isAdmin);
        if (!planCheck.ok) {
          return JSON.stringify({
            error: 'plan.limit_exceeded',
            message: planCheck.error.message,
            limit: planCheck.error.limit,
            current: planCheck.error.current,
          });
        }
      }

      // ── Resolve authorization mode (matching form route pattern) ────────
      const authorizationMode = resolveAuthorizationMode({
        skillIds,
        submittedAuthorizationMode: undefined,
        authorizationModeProvided: false,
      });

      // ── Shared create-time normalization ────────────────────────────────
      const createFields = await prepareAgentCreateFields({
        name,
        prompt,
        skillIds,
        style,
        capabilityMode,
        hybridMode,
        strategyPreset,
        capital: parsed.data.capital ?? null,
        skillPresetId: parsed.data.skillPresetId,
        connectionIds,
        toolPolicy: null,
        platformAssessment,
        authorizationMode: authorizationMode.value,
        executionDefaults: executionDefaults as import('@herobids/domain').ExecutionDefaults | null,
        strategy: strategy as import('@herobids/domain').StrategyIdentity | null,
        runtimePolicyOverrides: null,
        db,
        userId,
        plansConfig,
        userPlanId,
        isAdmin,
        agentRiskDefaults,
      });

      // ── Resolve model configuration ────────────────────────────────────
      const userAiConfig = normalizePersistedAiModelConfig(userRow?.aiModelConfig);
      const operatorDefaults = modelDefaults?.provider && modelDefaults?.lightModel && modelDefaults?.heavyModel
        ? { provider: modelDefaults.provider, lightModel: modelDefaults.lightModel, heavyModel: modelDefaults.heavyModel }
        : null;
      if (!userAiConfig && !operatorDefaults) {
        return JSON.stringify({
          error: 'config.model_settings_required',
          message: 'Before I can create an agent, you need to configure your AI model settings. Go to Settings → AI Models and choose a provider and models, then come back and try again.',
        });
      }
      const effectiveModelPolicy: Record<string, unknown> = userAiConfig ? {} : operatorDefaults!;

      const agentId = uuid();
      const timestamp = now();

      // ── Validate and resolve skill assignments (before transaction) ───
      const skillPlanPolicy = plansConfig
        ? resolvePlanSkillEntitlements(plansConfig, userPlanId, isAdmin)
        : { canViewMarketplaceSkills: true };
      const assignmentResolution = await resolveSkillAssignmentsForUser(
        db,
        userId,
        skillIds,
        new Set(),
        skillPlanPolicy.canViewMarketplaceSkills,
      );
      if (assignmentResolution.error) {
        return JSON.stringify({
          error: assignmentResolution.error.code,
          message: assignmentResolution.error.message,
          details: assignmentResolution.error.details,
        });
      }

      try {
        await db.transaction(async (tx) => {
          // Validate connection ownership and type compatibility.
          if (connectionIds.length > 0) {
            const connRows = await tx
              .select({
                id: connections.id,
                status: connections.status,
                resolvedVenueAccountId: connections.resolvedVenueAccountId,
              })
              .from(connections)
              .where(
                and(
                  eq(connections.userId, userId),
                  eq(connections.status, 'active'),
                ),
              );

            const validConnIds = new Set(connRows.map((r) => r.id));
            for (const cid of connectionIds) {
              if (!validConnIds.has(cid)) {
                throw new Error(`Connection ${cid} is not valid or does not belong to you`);
              }
            }

            // Type-compatibility check: trading presets need trading connections.
            const selectedRows = connRows.filter((r) => connectionIds.includes(r.id));
            for (const row of selectedRows) {
              const isTradingConn = row.resolvedVenueAccountId !== null;
              if (isTradingPreset && !isTradingConn) {
                throw new Error(`Connection ${row.id} is not a trading venue — trading agents require an exchange or DEX connection.`);
              }
              if (!isTradingPreset && isTradingConn) {
                throw new Error(`Connection ${row.id} is a trading venue — non-trading agents should use a service connection (e.g. Gmail).`);
              }
            }
          }

          await tx.insert(agents).values({
            id: agentId,
            userId,
            name,
            prompt,
            status: 'stopped',
            style: style as 'careful' | 'balanced' | 'bold' | null,
            capital: parsed.data.capital ?? null,
            strategy: createFields.strategy as Record<string, unknown> | null,
            executionDefaults: createFields.executionDefaults as { mode: string; slippageBps: number } | null,
            toolPolicy: createFields.toolPolicy,
            modelPolicy: effectiveModelPolicy,
            unifiedConfig: createFields.unifiedConfig as never,
            maxBots: createFields.maxBots,
            risk: createFields.risk,
            runtimePolicyOverrides: createFields.runtimePolicyOverrides,
            notificationPolicy: createFields.notificationPolicy,
            wakePreferences: null,
            telegramChatId: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          } as never);

          // Create agent_connections rows
          for (const cid of connectionIds) {
            await tx.insert(agentConnections).values({
              id: uuid(),
              agentId,
              connectionId: cid,
              status: 'active',
              grantedBy: userId,
              grantedAt: timestamp,
              createdAt: timestamp,
              updatedAt: timestamp,
            } as never);
          }
        });

        // ── Sync skill assignments (after transaction, matching form route) ──
        if (assignmentResolution.assignments && assignmentResolution.assignments.length > 0) {
          await syncAgentSkillAssignments(db, agentId, userId, assignmentResolution.assignments, 'guided_setup');
        }

        // Look up the agent's connected provider for the response summary.
        let walletAddress: string | undefined;
        let venue: string | undefined;
        if (isTradingPreset) {
          try {
            const venueRows = await db
              .select({
                address: connections.providerRef,
                provider: connections.provider,
              })
              .from(agentConnections)
              .innerJoin(connections, eq(agentConnections.connectionId, connections.id))
              .where(eq(agentConnections.agentId, agentId))
              .limit(1);

            walletAddress = venueRows[0]?.address ?? undefined;
            venue = venueRows[0]?.provider ?? undefined;
          } catch {
            // Non-critical — proceed without wallet info
          }
        }

        const result: Record<string, unknown> = {
          success: true,
          agentId,
          name,
          preset: parsed.data.skillPresetId,
        };
        if (isTradingPreset) {
          result.displayExecutionMode = parsed.data.requestedExecutionMode ?? 'test';
          result.executionDefaults = createFields.executionDefaults;
          result.capital = parsed.data.capital;
          if (venue) result.venue = venue;
          if (walletAddress) result.walletAddress = walletAddress;
        }
        return JSON.stringify(result);
      } catch (err) {
        return JSON.stringify({
          error: 'agent_creation_failed',
          message: err instanceof Error ? err.message : 'Failed to create agent',
        });
      }
    }

    default:
      return JSON.stringify({ error: 'unknown_action', message: `Unknown action: ${toolCall.name}` });
  }
}

interface LlmInvocationResult {
  content: string;
  actions?: ChatAction[];
  toolCallsProcessed: number;
  /** Set when an agent was successfully created during this invocation */
  createdAgent?: {
    agentId: string;
    name: string;
    displayExecutionMode: string;
    capital: string;
    preset: string;
    venue?: string;
    walletAddress?: string;
  };
  /** Enriched summary facts extracted from tool results */
  summaryFacts?: Partial<NonNullable<ThreadMetadata['summary']>>;
  /** Aggregate LLM usage across all invocations in this onboarding call */
  billingUsage?: AggregateChatLlmUsage;
}

// ── LLM Invocation ───────────────────────────────────────────────────────────

export async function invokeOnboardingLlm(
  llmConfig: LlmConfig,
  providersYaml: ProvidersYaml,
  db: Database,
  userId: string,
  threadMessages: PersistedChatMessage[],
  threadMetadata: ThreadMetadata | null,
  resumeEvent?: OnboardingResumeEvent,
  usageBillingRepo?: UsageBillingRepository,
  modelDefaults?: ModelDefaults,
  plansConfig?: PlansConfig,
  agentRiskDefaults?: AgentRiskDefaultsConfig,
): Promise<LlmInvocationResult> {
  const systemPrompt = buildSystemPrompt();

  // Build the summary block from metadata
  const summaryBlock = threadMetadata?.summary
    ? `\n\n## Current Setup Progress\n${JSON.stringify(threadMetadata.summary, null, 2)}`
    : '';

  // Explicit resume-event block — the primary signal for post-action resumes.
  // The summary block alone is insufficient because the model must not have to
  // infer state transitions from metadata JSON.
  const resumeBlock = buildResumePromptBlock(resumeEvent ?? null);

  const fullSystemPrompt = systemPrompt + summaryBlock + resumeBlock;

  // Build messages array for LLM
  const messages: LlmMessage[] = [
    { role: 'system', content: fullSystemPrompt },
  ];

  // Add last N persisted messages (sliding window)
  const recentMessages = threadMessages.slice(-MAX_MESSAGE_HISTORY);
  for (const msg of recentMessages) {
    if (msg.role === 'user') {
      messages.push({ role: 'user', content: msg.content });
    } else {
      messages.push({ role: 'assistant', content: msg.content });
    }
  }

  // Append a transient user-like event message so the model responds to a fresh
  // event rather than its own earlier assistant text. Not persisted.
  const resumeEventMessage = buildResumeEventMessage(resumeEvent ?? null);
  if (resumeEventMessage) {
    messages.push(resumeEventMessage);
  }

  let toolCallsProcessed = 0;
  const MAX_TOOL_ROUNDS = 5;
  let createdAgent: LlmInvocationResult['createdAgent'];
  const summaryFacts: Partial<NonNullable<ThreadMetadata['summary']>> = {};
  const pendingActions: ChatAction[] = [];

  const usageAcc: AggregateChatLlmUsage = {
    provider: llmConfig.provider,
    model: llmConfig.model,
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    cachedInputTokens: 0,
    tokensUsed: 0,
  };

  // Tool calling loop
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const result = await callLlmProvider(
      {
        provider: llmConfig.provider,
        model: llmConfig.model,
        maxTokens: llmConfig.maxTokens,
        timeoutMs: llmConfig.timeoutMs,
        baseUrl: llmConfig.baseUrl,
      },
      {
        messages,
        maxTokens: llmConfig.maxTokens,
        tools: CHAT_TOOLS,
        toolChoice: 'auto',
      },
    );

    if (!result.ok) {
      return {
        content: `I'm having trouble processing your request right now. Please try again or use the form instead. (Error: ${result.error.message})`,
        toolCallsProcessed,
        summaryFacts,
        actions: pendingActions,
        billingUsage: usageAcc.tokensUsed > 0 ? usageAcc : undefined,
      };
    }

    const { content, toolCalls } = result.data;

    // Accumulate usage from this successful call
    usageAcc.provider = result.data.provider;
    usageAcc.model = result.data.model;
    usageAcc.inputTokens += result.data.inputTokens ?? 0;
    usageAcc.outputTokens += result.data.outputTokens ?? 0;
    usageAcc.thinkingTokens += result.data.thinkingTokens ?? 0;
    usageAcc.cachedInputTokens += result.data.cachedInputTokens ?? 0;
    usageAcc.tokensUsed += result.data.tokensUsed ?? 0;

    // If no tool calls, return the assistant response
    if (!toolCalls || toolCalls.length === 0) {
      return { content: content || buildResumeFallback(resumeEvent ?? null), toolCallsProcessed, summaryFacts, actions: pendingActions, billingUsage: usageAcc.tokensUsed > 0 ? usageAcc : undefined };
    }

    // Process tool calls
    const toolResults: LlmMessage[] = [];
    for (const tc of toolCalls) {
      const toolResult = await executeChatAction(tc, db, userId, providersYaml, usageBillingRepo, modelDefaults, plansConfig, agentRiskDefaults);
      toolResults.push({
        role: 'tool',
        content: toolResult,
        toolCallId: tc.id,
        toolName: tc.name,
        addedAtTurn: round,
      });
      toolCallsProcessed++;

      // Emit a form action only from an explicit request_connection_form call.
      // Deduplicate so multiple calls in the same turn yield one rendered form.
      if (tc.name === 'request_connection_form') {
        if (!pendingActions.some((a) => a.type === 'form' && a.form === 'connection')) {
          let preferredCapability: string | null = null;
          let preferredProvider: string | null = null;
          try {
            const parsed = JSON.parse(toolResult) as Record<string, unknown>;
            if (typeof parsed.preferredCapability === 'string') preferredCapability = parsed.preferredCapability;
            if (typeof parsed.preferredProvider === 'string') preferredProvider = parsed.preferredProvider;
          } catch {
            // Non-JSON tool result — no hints
          }
          pendingActions.push({
            id: `connection-form-${round}`,
            type: 'form',
            form: 'connection',
            props: {
              ...(preferredCapability ? { preferredCapability } : {}),
              ...(preferredProvider ? { preferredProvider } : {}),
            },
          });
        }
      }

      // Extract structured facts from tool results
      try {
        const parsed = JSON.parse(toolResult) as Record<string, unknown>;
        if (tc.name === 'list_compatible_connections' && parsed.recommended && typeof parsed.recommended === 'object') {
          const rec = parsed.recommended as Record<string, unknown>;
          if (rec.id) summaryFacts.connectionIds = [rec.id as string];
        }
        if (tc.name === 'create_agent' && parsed.success && parsed.agentId) {
          createdAgent = {
            agentId: parsed.agentId as string,
            name: parsed.name as string,
            displayExecutionMode: (parsed.displayExecutionMode as string) ?? 'test',
            capital: (parsed.capital as string) ?? '',
            preset: (parsed.preset as string) ?? 'trading',
            venue: parsed.venue as string | undefined,
            walletAddress: parsed.walletAddress as string | undefined,
          };
          summaryFacts.preset = createdAgent.preset;
          summaryFacts.capital = createdAgent.capital;
        }
      } catch {
        // Non-JSON tool result — skip extraction
      }
    }

    // Add assistant message with tool calls
    messages.push({
      role: 'assistant',
      content: content || '',
      toolCalls,
    });

    // Add tool results
    messages.push(...toolResults);
  }

  // If we exhausted tool rounds, make one final call without tools
  const finalResult = await callLlmProvider(
    {
      provider: llmConfig.provider,
      model: llmConfig.model,
      maxTokens: llmConfig.maxTokens,
      timeoutMs: llmConfig.timeoutMs,
      baseUrl: llmConfig.baseUrl,
    },
    {
      messages,
      maxTokens: llmConfig.maxTokens,
      tools: undefined,
    },
  );

  if (!finalResult.ok) {
    return {
      content: 'I\'ve gathered the information needed. Let me summarize what we have before creating your agent.',
      toolCallsProcessed,
      summaryFacts,
      actions: pendingActions,
      billingUsage: usageAcc.tokensUsed > 0 ? usageAcc : undefined,
    };
  }

  // Accumulate usage from the final successful call
  usageAcc.provider = finalResult.data.provider;
  usageAcc.model = finalResult.data.model;
  usageAcc.inputTokens += finalResult.data.inputTokens ?? 0;
  usageAcc.outputTokens += finalResult.data.outputTokens ?? 0;
  usageAcc.thinkingTokens += finalResult.data.thinkingTokens ?? 0;
  usageAcc.cachedInputTokens += finalResult.data.cachedInputTokens ?? 0;
  usageAcc.tokensUsed += finalResult.data.tokensUsed ?? 0;

  return { content: finalResult.data.content, toolCallsProcessed, createdAgent, summaryFacts, actions: pendingActions, billingUsage: usageAcc.tokensUsed > 0 ? usageAcc : undefined };
}

// ── Route Registration ───────────────────────────────────────────────────────

export async function chatRoutes(
  app: FastifyInstance,
  db: Database,
  llmConfig: LlmConfig,
  providersYaml: ProvidersYaml,
  _redisClient: Redis,
  usageBillingRepo?: UsageBillingRepository,
  chatUsageBillingRecorder?: ChatUsageBillingRecorder,
  modelDefaults?: ModelDefaults,
  plansConfig?: PlansConfig,
  agentRiskDefaults?: AgentRiskDefaultsConfig,
): Promise<void> {
  /**
   * POST /chat/threads
   * Create a new chat thread and return the initial greeting.
   */
  app.post('/chat/threads', async (request, reply) => {
    try {
      const { thread, greetingMessage } = await createThread(db, request.userId);

      return reply.status(201).send({
        thread: {
          id: thread.id,
          title: thread.title,
          createdAt: thread.createdAt,
        },
        message: greetingMessage,
      });
    } catch (err) {
      request.log.error({ err }, 'Failed to create chat thread');
      return reply.status(500).send(errorPayload('internal_error', 'Failed to create chat thread'));
    }
  });

  /**
   * GET /chat/threads/:id
   * Get one onboarding thread with persisted messages.
   */
  app.get<{ Params: { id: string } }>('/chat/threads/:id', async (request, reply) => {
    const result = await getThreadWithMessages(db, request.params.id, request.userId);
    if (!result) {
      return reply.status(404).send(errorPayload('not_found', 'Thread not found'));
    }

    return reply.send({
      thread: {
        id: result.thread.id,
        title: result.thread.title,
        metadata: result.thread.metadata as ThreadMetadata | null,
        createdAt: result.thread.createdAt,
        updatedAt: result.thread.updatedAt,
      },
      messages: result.messages,
    });
  });

  /**
   * POST /chat/threads/:id/messages
   * Send a user message and get an assistant response.
   */
  app.post<{ Params: { id: string }; Body: unknown }>('/chat/threads/:id/messages', async (request, reply) => {
    // Validate thread exists and belongs to user
    const threadResult = await getThreadWithMessages(db, request.params.id, request.userId);
    if (!threadResult) {
      return reply.status(404).send(errorPayload('not_found', 'Thread not found'));
    }

    // Check if thread already completed (agent created)
    const metadata = threadResult.thread.metadata as ThreadMetadata | null;
    if (metadata?.createdAgentId) {
      return reply.status(400).send(errorPayload('thread_completed', 'This thread has already created an agent. Start a new thread to create another.'));
    }

    // Validate request body
    const parsed = SendMessageSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
    }

    const { content } = parsed.data;

    // Billing gate: block paid LLM calls when user has no available credit
    if (usageBillingRepo) {
      const account = await usageBillingRepo.getAccountByUserId(request.userId);
      const canSpendResult = account
        ? await usageBillingRepo.canSpendNow(account.id)
        : null;
      // Fresh user (no billing account) = allow spending
      if (canSpendResult && !canSpendResult.canSpend) {
        return reply.status(402).send(errorPayload(
          'billing.top_up_required',
          'You need to add credit to continue using Guided Setup.',
          { reason: canSpendResult.reason, availableMicrousd: canSpendResult.availableMicrousd },
        ));
      }
    }

    try {
      // Persist user message
      const userMsgId = uuid();
      const userMsgTimestamp = now();
      await db.insert(chatMessages).values({
        id: userMsgId,
        threadId: request.params.id,
        role: 'user',
        content,
        createdAt: userMsgTimestamp,
      } as never);

      // Build message list including the new user message
      const allMessages: PersistedChatMessage[] = [
        ...threadResult.messages,
        {
          id: userMsgId,
          role: 'user',
          content,
          actions: null,
          createdAt: userMsgTimestamp.toISOString(),
        },
      ];

      // Invoke onboarding LLM
      const llmResponse = await invokeOnboardingLlm(
        llmConfig,
        providersYaml,
        db,
        request.userId,
        allMessages,
        metadata,
        undefined,
        usageBillingRepo,
        modelDefaults,
        plansConfig,
        agentRiskDefaults,
      );

      // Record chat LLM usage for billing (fire-and-forget)
      if (chatUsageBillingRecorder && llmResponse.billingUsage?.tokensUsed > 0) {
        void chatUsageBillingRecorder.record({
          userId: request.userId,
          threadId: request.params.id,
          billingAnchorId: userMsgId,
          phase: 'message_send',
          usage: llmResponse.billingUsage,
        }).catch((err) => {
          request.log.warn({ err, threadId: request.params.id, userMsgId }, 'Failed to record chat LLM usage');
        });
      }

      // Build structured actions from agent creation result, merging any
      // form/quick-reply actions emitted by the LLM with the post-creation confirm.
      const actions: ChatAction[] = [
        ...(llmResponse.actions ?? []),
        ...(llmResponse.createdAgent ? [{
          id: 'post-creation',
          type: 'confirm' as const,
          props: {
            message: `Agent "${llmResponse.createdAgent.name}" created successfully in ${llmResponse.createdAgent.displayExecutionMode} mode!`,
            agentId: llmResponse.createdAgent.agentId,
            name: llmResponse.createdAgent.name,
            mode: llmResponse.createdAgent.displayExecutionMode,
            capital: llmResponse.createdAgent.capital,
          },
        }] : []),
      ];

      // Update thread metadata with enriched summary and createdAgentId
      const detectedPreset = detectPresetFromContent(content);
      const metadataUpdate: ThreadMetadata = {
        ...(metadata ?? {}),
        ...(llmResponse.createdAgent ? {
          createdAgentId: llmResponse.createdAgent.agentId,
          completedAt: new Date().toISOString(),
        } : {}),
        summary: {
          ...(metadata?.summary ?? {}),
          ...(llmResponse.summaryFacts ?? {}),
          // Persist the preset when determinable so resumed turns (e.g. after
          // Gmail OAuth) retain the active setup type without re-deriving it.
          ...(detectedPreset ? { preset: detectedPreset } : {}),
          step: llmResponse.createdAgent ? 'completed' : 'conversation',
        },
      };

      await db.update(chatThreads)
        .set({
          metadata: metadataUpdate as Record<string, unknown>,
          updatedAt: now(),
        })
        .where(eq(chatThreads.id, request.params.id));

      // Persist assistant message
      const assistantMsgId = uuid();
      const assistantMsgTimestamp = now();
      await db.insert(chatMessages).values({
        id: assistantMsgId,
        threadId: request.params.id,
        role: 'assistant',
        content: llmResponse.content,
        actions: actions.length > 0 ? actions : null,
        createdAt: assistantMsgTimestamp,
      } as never);

      return reply.send({
        message: {
          id: assistantMsgId,
          role: 'assistant',
          content: llmResponse.content,
          actions: actions.length > 0 ? actions : null,
          createdAt: assistantMsgTimestamp.toISOString(),
        },
      });
    } catch (err) {
      request.log.error({ err }, 'Failed to process chat message');
      return reply.status(500).send(errorPayload('internal_error', 'Failed to process message'));
    }
  });

  /**
   * POST /chat/threads/:id/actions/:actionId
   * Submit a form action result (e.g., connection created or cancelled).
   * Validates the result, updates thread state, and resumes the onboarding LLM.
   */
  app.post<{ Params: { id: string; actionId: string }; Body: unknown }>(
    '/chat/threads/:id/actions/:actionId',
    async (request, reply) => {
      const threadResult = await getThreadWithMessages(db, request.params.id, request.userId);
      if (!threadResult) {
        return reply.status(404).send(errorPayload('not_found', 'Thread not found'));
      }

      const parsed = ActionResultSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
      }

      const result = parsed.data.result as Record<string, unknown> | undefined;
      if (!result || typeof result !== 'object') {
        return reply.status(400).send(errorPayload('invalid_action_result', 'Unsupported action result type'));
      }

      const metadata = threadResult.thread.metadata as ThreadMetadata | null;
      const actionId = request.params.actionId;

      // Idempotency backstop: if this action was already processed, no-op with
      // the current thread state (no duplicate resume, no duplicate message).
      const processedActionIds = metadata?.processedActionIds ?? [];
      if (processedActionIds.includes(actionId)) {
        return reply.send({
          acknowledged: true,
          alreadyProcessed: true,
          message: null,
        });
      }

      const isCancellation = result.cancelled === true;
      const connectionId = typeof result.connectionId === 'string' ? result.connectionId : undefined;

      if (!isCancellation && !connectionId) {
        return reply.status(400).send(errorPayload('invalid_action_result', 'Unsupported action result type'));
      }

      // Validate the connection belongs to the user and is active before linking.
      let providerHint: string | undefined;
      if (connectionId) {
        const [conn] = await db
          .select({ id: connections.id, status: connections.status, provider: connections.provider })
          .from(connections)
          .where(and(eq(connections.id, connectionId), eq(connections.userId, request.userId)))
          .limit(1);

        if (!conn || conn.status !== 'active') {
          return reply.status(400).send(errorPayload('invalid_connection', 'Connection is not valid or is not active'));
        }
        providerHint = conn.provider;
      }

      // Build updated thread metadata.
      const existingConnectionIds = metadata?.summary?.connectionIds ?? [];
      const nextConnectionIds = connectionId
        ? Array.from(new Set([...existingConnectionIds, connectionId]))
        : existingConnectionIds;

      const updatedMetadata: ThreadMetadata = {
        ...(metadata ?? {}),
        processedActionIds: [...processedActionIds, actionId],
        summary: {
          ...(metadata?.summary ?? {}),
          connectionIds: nextConnectionIds,
          step: isCancellation ? 'connection_form_cancelled' : 'connection_linked',
        },
      };

      await db.update(chatThreads)
        .set({
          metadata: updatedMetadata as Record<string, unknown>,
          updatedAt: now(),
        })
        .where(eq(chatThreads.id, request.params.id));

      // Resume the onboarding LLM with the updated metadata so the conversation
      // continues automatically after linking or dismissing the form. Pass an
      // explicit resume event so the resumed call is unambiguous about what
      // just happened (not just summary.step).
      const resumeEvent: OnboardingResumeEvent = isCancellation
        ? { kind: 'connection_form_cancelled', actionContext: 'guided_setup_connection' }
        : { kind: 'connection_linked', connectionId, providerHint, actionContext: 'guided_setup_connection' };

      // Billing gate: block paid LLM call when user has no available credit.
      // Connection-link metadata updates are not paid actions and persist regardless.
      if (usageBillingRepo) {
        const account = await usageBillingRepo.getAccountByUserId(request.userId);
        const canSpendResult = account
          ? await usageBillingRepo.canSpendNow(account.id)
          : null;
        if (canSpendResult && !canSpendResult.canSpend) {
          return reply.status(402).send(errorPayload(
            'billing.top_up_required',
            'You need to add credit to continue using Guided Setup.',
            { reason: canSpendResult.reason, availableMicrousd: canSpendResult.availableMicrousd },
          ));
        }
      }

      const llmResponse = await invokeOnboardingLlm(
        llmConfig,
        providersYaml,
        db,
        request.userId,
        threadResult.messages,
        updatedMetadata,
        resumeEvent,
        usageBillingRepo,
        modelDefaults,
        plansConfig,
        agentRiskDefaults,
      );

      // Record chat LLM usage for billing (fire-and-forget)
      if (chatUsageBillingRecorder && llmResponse.billingUsage?.tokensUsed > 0) {
        void chatUsageBillingRecorder.record({
          userId: request.userId,
          threadId: request.params.id,
          billingAnchorId: actionId,
          phase: 'action_result',
          usage: llmResponse.billingUsage,
        }).catch((err) => {
          request.log.warn({ err, threadId: request.params.id, actionId }, 'Failed to record chat LLM usage');
        });
      }

      const resumeActions: ChatAction[] = [
        ...(llmResponse.actions ?? []),
        ...(llmResponse.createdAgent ? [{
          id: 'post-creation',
          type: 'confirm' as const,
          props: {
            message: `Agent "${llmResponse.createdAgent.name}" created successfully in ${llmResponse.createdAgent.displayExecutionMode} mode!`,
            agentId: llmResponse.createdAgent.agentId,
            name: llmResponse.createdAgent.name,
            mode: llmResponse.createdAgent.displayExecutionMode,
            capital: llmResponse.createdAgent.capital,
          },
        }] : []),
      ];

      // Persist exactly one assistant message — the resumed LLM output.
      const assistantMsgId = uuid();
      const assistantMsgTimestamp = now();
      await db.insert(chatMessages).values({
        id: assistantMsgId,
        threadId: request.params.id,
        role: 'assistant',
        content: llmResponse.content,
        actions: resumeActions.length > 0 ? resumeActions : null,
        createdAt: assistantMsgTimestamp,
      } as never);

      return reply.send({
        acknowledged: true,
        message: {
          id: assistantMsgId,
          role: 'assistant' as const,
          content: llmResponse.content,
          actions: resumeActions.length > 0 ? resumeActions : null,
          createdAt: assistantMsgTimestamp.toISOString(),
        },
      });
    },
  );
}
