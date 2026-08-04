import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { eq, and, asc } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Database } from '@herobids/db';
import { chatThreads, chatMessages, connections, agentConnections, agents } from '@herobids/db';
import { callLlmProvider } from '@herobids/llm';
import type { LlmToolDefinition, LlmToolCall, LlmMessage } from '@herobids/llm';
import type { AppConfig, ProvidersYaml } from '@herobids/domain';
import { errorPayload } from '../error-payload.js';

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
to understand the available options. Use them before asking the user to make choices.

You run inside a restricted API-local onboarding runtime. You may use the onboarding actions when needed, but do not assume worker runtime tools like send_message, memory, or trading execution tools exist.

You can create an agent directly using the create_agent action when you have enough information.

Prefer the happy path unless the user asks for something specific. That means:
- The user must choose the agent type/preset.
- The user must specify capital.
- If the user does not provide a custom goal, use the configurable default goal text.
- If the user does not ask for a specific style, use \`balanced\`.
- If the user does not ask for a specific execution mode, use the user-facing \`test\` choice. The server maps that to canonical \`executionDefaults.mode\`.
- If the user does not ask for a specific strategy preset, choose one automatically.
- If the server returns a recommended compatible active connection, use it automatically and avoid asking the user to create another connection.
- Before creation, show a confirmation summary that includes the final goal/prompt, style, user-facing execution mode, strategy preset, and selected connection.

## Greeting
When starting, say something like:

"Hi! I can help you create an AI agent. What kind of agent are you looking for?"

Then offer the available presets as quick-reply buttons (trading, personal assistant, custom).
Do NOT say "ask anything" — you have a specific job.

## Conversation Flow

### If the user wants a trading agent:
1. Confirm they want a trading agent and, if needed, ask which trading type/preset they want
2. Ask about capital (how much do they want to allocate?)
3. Reuse the server-recommended compatible existing active connection if one exists; only ask the user to create/connect something if none exists or they want a different one
4. Ask optional preference questions only when needed (e.g. chain, style, strategy, goal)
5. Otherwise apply the happy-path defaults for goal, style, user-facing execution mode, and strategy preset
6. Summarize and confirm before creating

### If the user wants a personal assistant:
1. Confirm they want a personal assistant and determine the preset/skill shape
2. Ask only the minimum extra questions needed to create it successfully
3. Reuse the server-recommended compatible existing active connection if one exists; only ask for a new connection when needed
4. Otherwise apply the happy-path defaults for name, goal, and execution settings
5. Summarize and confirm before creating

## Prompt / Goal Handling

- The current create-agent API still requires a prompt/goal shape, so Guided Setup must make this explicit.
- If the user provides a custom goal, use it.
- If the user does not provide one, the server synthesizes the final prompt deterministically from the configurable default goal text plus the collected onboarding facts.
- The synthesized prompt/goal must appear in the confirmation summary before \`create_agent\` runs.

### Rules:
- You are single-purpose: create agents. Nothing else.
- Never ask for private keys, API secrets, or passwords.
- When the user needs to connect a wallet or exchange, request the secure connection form action so the frontend renders the appropriate setup UI.
- Always validate your understanding before calling create_agent.
- After creating, remind the user of important next steps.
- The user can always say "skip" or "use the form" to switch to the form-based flow.
- Cover the happy path (~6-8 key fields). Advanced settings are in the form.`;
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
    description: 'List the user\'s existing active connections that are compatible with agent creation. Returns recommended connections if available.',
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
        capital: { type: 'string', description: 'Trading capital allocation in USD' },
        goal: { type: 'string', description: 'Custom goal/prompt for the agent (optional)' },
        style: { type: 'string', enum: ['careful', 'balanced', 'bold'], description: 'Trading style (default: balanced)' },
        requestedExecutionMode: { type: 'string', enum: ['test', 'live'], description: 'User-facing execution mode (default: test)' },
        strategyPreset: { type: 'string', enum: ['momentum', 'momentum-position', 'range', 'swing', 'scalper', 'contrarian'], description: 'Strategy preset (auto-selected if omitted)' },
        selectedConnectionId: { type: 'string', description: 'Connection ID to use (auto-selected from recommended if omitted)' },
      },
      required: ['skillPresetId', 'capital'],
    },
  },
];

const GuidedSetupCreateAgentInput = z.object({
  skillPresetId: z.enum(['trading', 'direct-trading', 'trading-assistant', 'personal-assistant', 'custom']),
  capital: z.string().min(1),
  goal: z.string().optional(),
  style: z.enum(['careful', 'balanced', 'bold']).optional(),
  requestedExecutionMode: z.enum(['test', 'live']).optional(),
  strategyPreset: z.enum(['momentum', 'momentum-position', 'range', 'swing', 'scalper', 'contrarian']).optional(),
  selectedConnectionId: z.string().optional(),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function uuid(): string {
  return crypto.randomUUID();
}

function now(): Date {
  return new Date();
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function generateAgentName(preset: string): string {
  const prefix = preset === 'personal-assistant' ? 'PA' : preset === 'trading' ? 'TX' : 'AG';
  const suffix = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `${prefix}-${suffix}`;
}

/**
 * Synthesize the final agent prompt from the configurable default goal text
 * plus collected onboarding facts when the user does not provide a custom goal.
 */
function synthesizePrompt(goal: string | undefined, preset: string, capital: string): string {
  if (goal && goal.trim().length > 0) return goal.trim();
  // Configurable default — initial v1 default: "Grow this portfolio"
  if (preset === 'personal-assistant') return 'Assist with daily tasks and information retrieval';
  return `Grow this portfolio with ${capital} USDC allocation`;
}

/**
 * Map user-facing execution mode to canonical execution defaults.
 * 'test' → shadow mode, 'live' → live mode.
 */
function mapExecutionMode(requestedMode: string | undefined): { mode: 'paper' | 'shadow' | 'live'; slippageBps: number } {
  if (requestedMode === 'live') return { mode: 'live', slippageBps: 50 };
  return { mode: 'shadow', slippageBps: 50 };
}

/**
 * Build the full CreateAgentSchema payload from the guided setup input + server-side defaults.
 */
function buildCreateAgentPayload(
  input: z.infer<typeof GuidedSetupCreateAgentInput>,
  userId: string,
): Record<string, unknown> {
  const executionDefaults = mapExecutionMode(input.requestedExecutionMode);
  const prompt = synthesizePrompt(input.goal, input.skillPresetId, input.capital);
  const name = generateAgentName(input.skillPresetId);
  const style = input.style ?? 'balanced';
  const strategyPreset = input.strategyPreset ?? 'momentum';

  const connectionIds = input.selectedConnectionId ? [input.selectedConnectionId] : [];

  return {
    name,
    prompt,
    style,
    capital: input.capital,
    skillPresetId: input.skillPresetId,
    strategyPreset,
    executionDefaults,
    connectionIds,
    userId,
  };
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

async function executeChatAction(
  toolCall: LlmToolCall,
  db: Database,
  userId: string,
  _providersYaml: ProvidersYaml,
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
        const userConnections = await db
          .select({
            id: connections.id,
            provider: connections.provider,
            label: connections.label,
            status: connections.status,
          })
          .from(connections)
          .where(and(eq(connections.userId, userId), eq(connections.status, 'active')))
          .limit(10);

        if (userConnections.length === 0) {
          return JSON.stringify({ connections: [], message: 'No active connections found. The user will need to set one up.' });
        }

        return JSON.stringify({
          connections: userConnections,
          recommended: userConnections[0] ?? null,
          message: userConnections.length === 1
            ? 'One active connection found. Recommend using it.'
            : `${userConnections.length} active connections found. The first one is recommended.`,
        });
      } catch {
        return JSON.stringify({ connections: [], message: 'Could not retrieve connections.' });
      }
    }

    case 'create_agent': {
      const parsed = GuidedSetupCreateAgentInput.safeParse(toolCall.args);
      if (!parsed.success) {
        return JSON.stringify({
          error: 'validation_error',
          message: 'Invalid agent configuration.',
          details: parsed.error.issues,
        });
      }

      const payload = buildCreateAgentPayload(parsed.data, userId);

      try {
        // Insert agent
        const agentId = uuid();
        const timestamp = now();

        await db.insert(agents).values({
          id: agentId,
          userId,
          name: payload.name as string,
          prompt: payload.prompt as string,
          style: payload.style as 'careful' | 'balanced' | 'bold',
          capital: payload.capital as string,
          strategy: payload.strategyPreset ? {
            preset: payload.strategyPreset as string,
            params: {},
            source: 'guided_setup',
          } : null,
          executionDefaults: payload.executionDefaults as { mode: string; slippageBps: number } | null,
          status: 'stopped',
          createdAt: timestamp,
          updatedAt: timestamp,
        } as never);

        // Create agent_connections rows
        const connectionIds = payload.connectionIds as string[];
        for (const connId of connectionIds) {
          await db.insert(agentConnections).values({
            id: uuid(),
            agentId,
            connectionId: connId,
            grantedAt: timestamp,
          } as never);
        }

        return JSON.stringify({
          success: true,
          agentId,
          name: payload.name,
          displayExecutionMode: parsed.data.requestedExecutionMode ?? 'test',
          executionDefaults: payload.executionDefaults,
          capital: parsed.data.capital,
          preset: parsed.data.skillPresetId,
        });
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

// ── LLM Invocation ───────────────────────────────────────────────────────────

async function invokeOnboardingLlm(
  llmConfig: LlmConfig,
  providersYaml: ProvidersYaml,
  db: Database,
  userId: string,
  threadMessages: PersistedChatMessage[],
  threadMetadata: ThreadMetadata | null,
): Promise<{ content: string; actions?: ChatAction[]; toolCallsProcessed: number }> {
  const systemPrompt = buildSystemPrompt();

  // Build the summary block from metadata
  const summaryBlock = threadMetadata?.summary
    ? `\n\n## Current Setup Progress\n${JSON.stringify(threadMetadata.summary, null, 2)}`
    : '';

  const fullSystemPrompt = systemPrompt + summaryBlock;

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

  let toolCallsProcessed = 0;
  const MAX_TOOL_ROUNDS = 5;

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
      };
    }

    const { content, toolCalls } = result.data;

    // If no tool calls, return the assistant response
    if (!toolCalls || toolCalls.length === 0) {
      return { content: content || 'I understand. How can I help you further with setting up your agent?', toolCallsProcessed };
    }

    // Process tool calls
    const toolResults: LlmMessage[] = [];
    for (const tc of toolCalls) {
      const toolResult = await executeChatAction(tc, db, userId, providersYaml);
      toolResults.push({
        role: 'tool',
        content: toolResult,
        toolCallId: tc.id,
        toolName: tc.name,
        addedAtTurn: round,
      });
      toolCallsProcessed++;
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
    };
  }

  return { content: finalResult.data.content, toolCallsProcessed };
}

// ── Route Registration ───────────────────────────────────────────────────────

export async function chatRoutes(
  app: FastifyInstance,
  db: Database,
  llmConfig: LlmConfig,
  providersYaml: ProvidersYaml,
  _redisClient: Redis,
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
      );

      // Detect if agent was created from tool results (check the last tool result)
      let actions: ChatAction[] | undefined;
      let updatedMetadata = metadata;

      // If the LLM response mentions agent creation success, extract agent ID
      // and add post-creation actions
      if (llmResponse.content.toLowerCase().includes('created') && llmResponse.toolCallsProcessed > 0) {
        // Try to extract agent creation confirmation
        actions = [
          {
            id: 'post-creation',
            type: 'confirm',
            props: {
              message: 'Your agent has been created! You can view it on the Agents page.',
            },
          },
        ];
      }

      // Update thread metadata
      const metadataUpdate: ThreadMetadata = {
        ...(updatedMetadata ?? {}),
        summary: {
          ...(updatedMetadata?.summary ?? {}),
          step: 'conversation',
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
        actions: actions ?? null,
        createdAt: assistantMsgTimestamp,
      } as never);

      return reply.send({
        message: {
          id: assistantMsgId,
          role: 'assistant',
          content: llmResponse.content,
          actions: actions ?? null,
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
   * Submit a form action result (e.g., connection created).
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

      // Handle connection form submission result
      if (result && typeof result === 'object' && 'connectionId' in result) {
        const metadata = threadResult.thread.metadata as ThreadMetadata | null;
        const connectionId = result.connectionId as string;

        // Update thread metadata with the new connection
        const updatedMetadata: ThreadMetadata = {
          ...(metadata ?? {}),
          summary: {
            ...(metadata?.summary ?? {}),
            connectionIds: [
              ...(metadata?.summary?.connectionIds ?? []),
              connectionId,
            ],
            step: 'connection_linked',
          },
        };

        await db.update(chatThreads)
          .set({
            metadata: updatedMetadata as Record<string, unknown>,
            updatedAt: now(),
          })
          .where(eq(chatThreads.id, request.params.id));

        // Persist a system-style message acknowledging the action
        const ackMsgId = uuid();
        const ackTimestamp = now();
        await db.insert(chatMessages).values({
          id: ackMsgId,
          threadId: request.params.id,
          role: 'assistant',
          content: `Connection linked successfully. Let me continue setting up your agent.`,
          createdAt: ackTimestamp,
        } as never);

        return reply.send({
          acknowledged: true,
          message: {
            id: ackMsgId,
            role: 'assistant' as const,
            content: 'Connection linked successfully. Let me continue setting up your agent.',
            actions: null,
            createdAt: ackTimestamp.toISOString(),
          },
        });
      }

      return reply.status(400).send(errorPayload('invalid_action_result', 'Unsupported action result type'));
    },
  );
}
