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
import { listProviderRegistry, getProviderWalletGenerationCapability } from '../providers/registry.js';
import { prepareAgentCreateFields } from '../agents/agent-create-normalization.js';
import { resolveExecutionModeForSkills, validateConnectionRequirement, resolveAuthorizationMode } from './agent-config-helpers.js';
import { checkAgentLimit, resolvePlanSkillEntitlements } from '../plan-guards.js';
import { resolveSkillAssignmentsForUser, syncAgentSkillAssignments } from './agents.js';
import { createProviderLink } from './setup.js';
import { generateWallet } from '@herobids/venues';

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
  kind: 'connection_linked' | 'connection_form_cancelled' | 'connection_selected';
  connectionId?: string;
  providerHint?: string;
  actionContext?: 'guided_setup_connection';
}

/**
 * Invocation-local connection resolution context for the Guided Setup tool loop.
 * Tracks connections surfaced during this LLM invocation so create_agent can
 * auto-wire a compatible connection when the model omits selectedConnectionId.
 */
interface GuidedSetupResolvedConnectionContext {
  createdConnectionIds: string[];
  recommendedConnectionIds: string[];
  threadConnectionIds: string[];
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

/** Matches structured button-reply values sent by the frontend for connection-choice quick_replies. */
const BUTTON_VALUE_RE = /^(connection:[a-zA-Z0-9-]+|action:(create_connection|request_connection_form))$/;

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

// ── System Prompts ───────────────────────────────────────────────────────────

export function buildBaseHeader(): string {
  return `You are the Guided Setup assistant for OpenAIdom, a platform for creating and running AI agents.

Your ONLY job: help the user create an AI agent through conversation.

You are NOT a general-purpose chat assistant. Do not answer questions unrelated to agent creation. If the user asks
something outside agent creation, gently redirect: "I'm focused on helping you create an
agent right now. Would you like to continue, or switch to the [form](/agents/new)?"

You have access to skill discovery (list_available_skills — use only for Custom AI or when the user asks about specific skills) to understand the available options.

You run inside a restricted API-local onboarding runtime. You may use the onboarding actions when needed, but do not assume worker runtime tools like send_message, memory, or trading execution tools exist.

You can create an agent directly using the create_agent action when you have enough information.`;
}

export function buildBaseReference(): string {
  return `

## Important Rules

- You are single-purpose: create agents. Nothing else.
- Never ask for private keys, API secrets, or passwords.
- Whenever you open a form for the user to enter secrets (e.g. API keys, wallet secrets, or private keys), include a brief and emphasized security reminder: "Do not enter secrets directly into the chat. Only enter them into secure forms (within the chat) provided for that purpose."

## Important URLs

When directing the user to a page on the platform, use Markdown links so they are clickable:

- [Agent creation form](/agents/new)
- [Agents dashboard](/agents)
- [Connections page](/connections)
- [Billing page](/billing)
- [Settings page](/settings)

Prefer the happy path unless the user asks for something specific. That means:
- If the user does not provide a custom goal, use the configurable default goal text.
- If the user does not ask for a specific style, use \`balanced\` (applies to all agent types).
- If the server returns a recommended compatible active connection, use it automatically and avoid asking the user to create another connection.
- Before creation, show a confirmation summary so the user can review what will be created.

## Prompt / Goal Handling

- The current create-agent API still requires a prompt/goal shape, so Guided Setup must make this explicit.
- If the user provides a custom goal, use it.
- If the user does not provide one, the server synthesizes the final prompt deterministically from the configurable default goal text plus the collected onboarding facts.
- The synthesized prompt/goal must appear in the confirmation summary before \`create_agent\` runs.
- During fine-tuning, the user may customize the goal/prompt. Show the current goal text and ask if they want to change it.

## Minimum-Viable Checkpoint & Fine-Tuning

Once you have collected the minimum required information, pause and present the user with a fork before calling create_agent. This lets the user choose between creating immediately with sensible defaults or customizing further.

### How to present the fork

Present it as a numbered list in natural language. Tailor the fine-tune items shown to only what has NOT been explicitly set by the user yet:

"We have enough to create your agent at this point. However, we could continue fine-tuning by adjusting:

• Your agent's prompt/goal
• Telegram chat ID (for notifications)

What would you like to do?
1. Create my agent now — I'll fine-tune later
2. Let's fine-tune now"

Only list fine-tune items the user has NOT already explicitly set. If they already set everything (e.g. provided a custom goal, chose a style, and gave a telegram chat ID), skip the fork and go straight to the confirmation summary.

### If the user chooses "create now" (option 1)

Show the confirmation summary, then call create_agent.

### If the user chooses "fine-tune now" (option 2)

Enter fine-tuning mode. Start with:

"You can interrupt at any time to create your agent, whenever you're ready."

Walk through the optional fine-tune items ONE AT A TIME. Do not list them all at once — ask about each item, let the user respond, then move to the next or ask if they want to continue.

After each fine-tune item, ask something like: "Anything else you'd like to customize, or should I create your agent now?"

If the user says "create my agent", "create now", "done", "that's all", "I'm done", or similar — exit fine-tuning mode immediately. Show the confirmation summary and call create_agent. Do NOT keep offering more customization options after the user signals they're done.

#### Fine-tune item: Prompt / Goal

Ask: "Would you like to customize your agent's goal or prompt? Currently it's: '[current goal text]'. You can give it a more specific mission, personality, or focus if you'd like."

If the user provides a custom goal, use it. If they skip, keep the default.

#### Fine-tune item: Telegram Chat ID

Ask: "Would you like your agent to send you Telegram notifications? If so, here's how to get your Telegram chat ID:

1. Open Telegram and search for @OpenAIdomBot
2. Send /start to the bot
3. The bot will reply with your chat ID — paste it here

What's your Telegram chat ID? (Or say 'skip' if you don't want Telegram notifications.)"

If the user provides a chat ID, pass it as \`telegramChatId\` on the \`create_agent\` call. If they skip, omit it. Do NOT ask the user to enter their chat ID in Settings — collect it directly in the chat during fine-tuning.

### Rules:
- If listing options, prefer numbered lists. This way, the user can select an option by responding with its corresponding number instead of typing the full text.
- When the user needs to connect a provider, call \`list_compatible_connections\` first with the appropriate \`preferredCapability\`. If an existing active compatible connection works, reuse it. Never ask the user to type secrets, API keys, OAuth codes, or passwords into the chat.
- After the user completes or dismisses the connection form, the server resumes you automatically. If the connection was linked (\`step: 'connection_linked'\`), acknowledge it and continue. If the user dismissed the form (\`step: 'connection_form_cancelled'\`), acknowledge their choice and offer alternatives (reuse an existing connection, switch to the form, or continue without) — do NOT immediately call \`request_connection_form\` again for the same need.
- Always validate your understanding before calling create_agent.
- If a \`create_agent\` tool call returns a \`billing.top_up_required\` error, surface the top-up message to the user and do NOT retry \`create_agent\`. Tell the user to visit the [billing page](/billing) to add credit, or mention the standard [form](/agents/new) as an alternative.
- After creating, remind the user of important next steps and include a clickable link to the [agents dashboard](/agents) so they can see their new agent. If Telegram chat ID was NOT collected during fine-tuning, tell the user they can set up Telegram later by sending \`/start\` to \`@OpenAIdomBot\` on Telegram, and pasting the returned chat ID in their [Settings](/settings). If Telegram was already set up during fine-tuning, mention it as done and skip the Settings link.
- The user can always say "skip" or "use the form" to switch to the form-based flow. The agent creation form is at [agents/new](/agents/new).
- During fine-tuning, the user can say "create my agent", "create now", "done", or "that's all" at any time to exit fine-tuning mode and create the agent immediately. Respect this — do not keep offering customization options after the user signals they're done.
- Cover the happy path (~6-8 key fields). Advanced settings are in the [form](/agents/new).

## Resume After Connection Actions

When the runtime resumes you after a connection action, you will receive an explicit resume event describing what just happened. Treat it as the latest user-visible state change — it is the most recent thing that occurred, even though it is not a normal chat message.

- If the resume event says a connection was linked successfully, continue the setup flow from that point and do NOT ask the user to reconnect the provider.
- If the resume event says the connection form was dismissed, acknowledge the user's choice and offer alternatives (reuse an existing connection, switch to the form, or continue without). Do NOT immediately request the same connection form again.`;
}

export function buildBasePrompt(): string {
  return buildBaseHeader() + `

## Greeting
When starting, say something like:

"Hi! I can help you create an AI agent. What kind of agent are you looking for?"

Then present the available presets (trading, personal assistant, custom) as choices.
Do NOT say "ask anything" — you have a specific job.` + buildBaseReference();
}

export function buildTradingPrompt(): string {
  return buildBaseHeader() + `

## Trading Agent Setup

You are setting up a trading agent. The user has already chosen this preset.
Use \`skillPresetId: "direct-trading"\`. Default if unset: execution mode=\`test\`, strategy=\`momentum\`, style=\`balanced\`.
For all connection calls, pass \`preferredCapability: "trading"\`. Never auto-use a non-trading connection.

Follow these steps in order. Do not skip ahead.

### Step 1 — Experience Level

Ask: 

"1. Are you new to crypto? or
 2. Do you know what you want?"

- 1 → Fast Track: go to Step 2-F.
- 2 → Guided: go to Step 2-G.

### Step 2-F — Fast Track: Asset Preference

Ask: "What type of assets interest you? Bitcoin / Ethereum / Memecoins / Not sure"

| Answer | Venue | Strategy |
|---|---|---|
| Bitcoin | hyperliquid | momentum-position |
| Ethereum | hyperliquid | momentum-position |
| Memecoins | jupiter | momentum-position |
| Not sure | jupiter | momentum-position |

Apply these defaults without asking: \`authorizationMode\`="direct", \`filterTrades\`="scanner_gated", \`platformAssessmentEnabled\`=true, \`requestedExecutionMode\`="test", \`style\`="balanced", \`capital\`="Not specified".

Jump to Step 3.

### Step 2-G — Guided: Capital, Approval, Cost-Saving

Ask: "What's your trading capital in USD?"

Ask: "Should the agent execute trades automatically, or ask before each trade?"
- Auto → \`authorizationMode\`: "direct"
- Approval → \`authorizationMode\`: "approval_required"
(Use \`skillPresetId: "direct-trading"\` regardless. Do not expose internal preset names to the user.)

Ask: "To save on AI costs, our platform can pre-filter trading opportunities so your agent only evaluates promising setups instead of scanning the entire market. Enable this?"
- Yes → \`filterTrades\`="scanner_gated", \`platformAssessmentEnabled\`=true. Explain: "Your agent will only trade when our scanner finds promising setups. This keeps LLM costs down. I'll also enable periodic strategy reviews so your trading strategy stays tuned to market conditions."
- No → \`filterTrades\`="mixed". Explain: "Your agent will see scanner candidates and explore on its own. This gives it more freedom but costs more AI tokens."
- Explicitly disable all → \`filterTrades\`="off". Explain: the agent will rely purely on its own reasoning (most expensive).
When scanner_gated: do not ask about review interval — default to 12 hours.

### Step 3 — Connection

Call \`list_compatible_connections\` with \`preferredCapability: "trading"\`.

**If an existing compatible connection exists and the user has NOT expressed a venue preference:** reuse it silently. Do not mention connections. Go to Step 4.

**If the user named a venue** (e.g. "Hyperliquid", "I want Jupiter"):
First check the \`list_compatible_connections\` results. If a compatible active trading connection exists whose provider matches the named venue, reuse it silently and go to Step 4. Do not ask the wallet question.
If no same-provider connection exists, ask: "Do you have an existing wallet, or should I create one?"
- "I have one" → \`request_connection_form({ preferredProvider: "<venue>" })\`
- "Create one" → \`create_connection({ provider: "<venue>", credentialMode: "generated" })\`
  - Success: show wallet address and funding guidance. "Your [venue] wallet has been created. To start trading, fund it at: [address]. You'll need [network] tokens for gas."
  - Failure: offer "I have an existing wallet" (opens form) or "Skip for now" (paper mode). Do not retry \`create_connection\` for the same provider.

**If no compatible connection exists and no venue preference:**
Ask to narrow down:
- Q1: "Which blockchain ecosystem? Solana / EVM / Not sure"
- Q2: "Long only, or long + short?"

| Q1 | Q2 | Venue |
|---|---|---|
| Solana | long-only | jupiter |
| EVM | long-only | 1inch |
| EVM | long+short | hyperliquid |
| Not sure | long-only | jupiter |
| Not sure | long+short | hyperliquid |

Edge case Solana + long+short: explain no Solana perps venue exists, suggest Hyperliquid.
Once venue is locked, ask wallet choice (same as above: existing or create).

**Connection rules:**
- \`request_connection_form\` is a last resort — try existing gate, then generate, then form.
- When opening the form, pass \`preferredProvider\` scoped to the determined venue.
- \`create_connection\` is synchronous — continue the conversation immediately. The backend auto-assigns the connectionId in the next \`create_agent\` call.
- Generated wallets are the default for Fast Track. Available as a choice for Guided.
- Venue→provider: hyperliquid=Hyperliquid perps, jupiter=Jupiter DEX (Solana), 1inch=1inch DEX (EVM).

### Step 4 — Fine-Tune Checkpoint

Present the fine-tune fork. For Fast Track users, the approval-policy and cost-saving defaults are already applied — do not ask those questions — but DO present the checkpoint fork.

Additional trading fine-tune items (only if not already set):
- Trading style: careful / balanced / bold (current: balanced). "Your agent's trading style determines how aggressive or conservative it is. Careful: prioritizes capital preservation, smaller position sizes. Balanced: moderate risk, standard position sizing. Bold: willing to take larger positions for higher returns."
- Strategy preset: momentum / momentum-position / range / swing / scalper / contrarian (current: momentum).

When the user is ready, show the confirmation summary and call \`create_agent\`.

### Step 5 — Confirm and Create

Show summary: goal, style, execution mode, strategy, capital, connection/venue.
Call \`create_agent\`.
After creation: link to [agents dashboard](/agents). If no Telegram: mention [Settings](/settings).` + buildBaseReference();
}

export function buildPersonalAssistantPrompt(): string {
  return buildBaseHeader() + `

## Personal Assistant Setup

You are setting up a PERSONAL ASSISTANT agent. The user has already chosen this preset — do NOT ask them to choose a preset again.

### Conversation Flow
1. Confirm they want a personal assistant and determine the preset/skill shape
2. Ask only the minimum extra questions needed to create it successfully
3. Call list_compatible_connections with preferredCapability: "email" (or "other" as appropriate) to find non-trading connections (Gmail, etc.). Reuse the server-recommended compatible active connection if one exists; if multiple non-trading connections exist, ask the user which one to use. Only ask for a new connection when needed. Never suggest or auto-select a trading connection (exchanges, DEXs) for a personal assistant.
4. Apply the happy-path defaults for name, goal, and style
5. Once minimum required information is collected, present the fine-tune checkpoint. When the user is ready, show the confirmation summary and call create_agent.

**CRITICAL:** Do NOT ask about or include any trading-specific fields. Capital, execution mode, strategy preset, filterTrades, and platform assessment do NOT apply to personal assistants. Only collect: goal (if the user wants a custom one), style, and any needed provider connections. Omit capital, requestedExecutionMode, strategyPreset, filterTrades, and platformAssessment* from the create_agent call.

## Checkpoint Trigger (Personal Assistant)

Present the checkpoint after preset confirmation, goal (can default), style (defaults to balanced), and any needed connection are resolved.

## Confirmation Summary (Personal Assistant)

Include: goal/prompt, style, and selected connection only. Do NOT mention capital, execution mode, strategy, filterTrades, platform assessment, or "venue" (non-trading connections like Gmail are services, not venues — say "Connected to Gmail" not "Venue: Gmail").

For personal-assistant email-management flows, once Gmail is linked, proceed to the next missing setup field or summarize the collected information for creation rather than switching to generic conversation.` + buildBaseReference();
}

export function buildCustomPrompt(): string {
  return buildBaseHeader() + `

## Custom Agent Setup

You are setting up a CUSTOM agent. The user has already chosen this preset — do NOT ask them to choose a preset again.

### Conversation Flow
1. Confirm they want a custom agent.
2. Ask what they want their agent to do. Use list_available_skills to discover
   available skills, then suggest relevant ones based on their goal.
3. If the user doesn't express a need for specific skills, default to no skills
   (base only) — the agent can still reason and use built-in tools.
4. Do not ask for capital unless the selected skills include trading.
5. Apply the happy-path defaults for name, goal, and style.
6. Once minimum required information is collected, present the fine-tune checkpoint. When the user is ready, show the confirmation summary and call create_agent.

**CRITICAL for custom agents without trading skills:** Do NOT ask about or include capital, execution mode, strategy preset, filterTrades, or platform assessment. These are trading-only concepts. Only collect: goal, style, skill IDs, and any needed provider connections.

If the selected skills include trading capabilities, follow the trading agent connection flow (preferredCapability: "trading") and collect capital, execution mode, and strategy preset as you would for a trading agent. List available skills with list_available_skills to discover valid skill IDs before calling create_agent.

## Checkpoint Trigger (Custom Agent)

Present the checkpoint after goal, skill selection, style (defaults to balanced), and any needed connection are resolved.

## Confirmation Summary (Custom Agent)

Include: goal/prompt, style, and selected connection only. Do NOT mention capital, execution mode, strategy, filterTrades, platform assessment, or "venue" unless the custom skills include trading capabilities.` + buildBaseReference();
}

/** @deprecated Use buildBasePrompt() directly. Kept for backward compatibility with tests. */
export function buildSystemPrompt(): string {
  return buildBasePrompt();
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
  if (event.kind === 'connection_selected') {
    const provider = event.providerHint ? ` (${event.providerHint})` : '';
    return `\n\n## Resume Event\nThe user selected connection ${event.connectionId}${provider} from the connection-choice buttons. Use this connection for the agent. Continue the Guided Setup flow from the current state.`;
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
  if (event.kind === 'connection_selected') {
    const provider = event.providerHint ? ` (${event.providerHint})` : '';
    return { role: 'user', content: `System event: the user selected connection ${event.connectionId}${provider}. Continue the Guided Setup flow with this connection.` };
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
    return 'No problem — we can continue without a new connection, reuse an existing one, or switch to the [form](/agents/new). How would you like to proceed?';
  }
  if (event?.kind === 'connection_selected') {
    return `Connection selected. Let's continue setting up your agent with this connection.`;
  }
  return 'I understand. How can I help you further with setting up your agent?';
}

/**
 * Build a connection-choice quick_replies ChatAction listing venue-filtered
 * compatible connections plus "generate new wallet" and "enter my own keys".
 *
 * When venueHint is provided, only connections whose provider matches the hint
 * are listed as buttons. When absent, all provided connections are listed.
 */
export function buildConnectionChoiceActions(
  connections: Array<{ id: string; provider: string; label: string }>,
  venueHint?: string,
): ChatAction[] {
  const filtered = venueHint
    ? connections.filter((c) => c.provider === venueHint)
    : connections;

  const options: Array<{ label: string; value: string }> = filtered.map((c) => ({
    label: `${c.provider}: ${c.label}`,
    value: `connection:${c.id}`,
  }));

  options.push({ label: 'Generate a new wallet', value: 'action:create_connection' });
  options.push({ label: 'Enter my own keys', value: 'action:request_connection_form' });

  return [{ id: 'connection-choice', type: 'quick_replies', options }];
}

// ── Tool Definitions ─────────────────────────────────────────────────────────

const CHAT_TOOLS: LlmToolDefinition[] = [
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
    name: 'create_connection',
    description: 'Create a provider connection with auto-generated credentials. The result includes a connectionId that the backend auto-assigns when create_agent follows immediately. If you want a specific existing connection instead of the auto-resolved one, pass selectedConnectionId explicitly on create_agent. Use for the simplified path when the user has agreed to a specific venue and wants a generated wallet. Do NOT use if the user wants to provide their own API keys — use request_connection_form instead. The label is optional and will be auto-derived if omitted.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Provider ID: hyperliquid, jupiter, 1inch.' },
        label: { type: 'string', description: 'Human-readable label for this connection. Optional — server derives a default if omitted.' },
        capability: { type: 'string', enum: ['trading'] },
        credentialMode: { type: 'string', enum: ['generated'] },
      },
      required: ['provider', 'credentialMode'],
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
        skillPresetId: { type: 'string', enum: ['trading', 'direct-trading', 'trading-assistant', 'personal-assistant', 'custom'], description: 'The agent type/preset. For guided trading setup, use "direct-trading". "trading" bundles bot-management (not for guided flow). "trading-assistant" is a legacy approval-required preset — prefer "direct-trading" + authorizationMode instead.' },
        capital: { type: 'string', description: 'Trading capital allocation in USD. ONLY for trading presets (trading, direct-trading, trading-assistant). Omit for personal-assistant and custom agents.' },
        goal: { type: 'string', description: 'Custom goal/prompt for the agent (optional). Applies to all agent types.' },
        style: { type: 'string', enum: ['careful', 'balanced', 'bold'], description: 'Agent decision-making style (default: balanced). Applies to all agent types.' },
        requestedExecutionMode: { type: 'string', enum: ['test', 'live'], description: 'User-facing execution mode. ONLY for trading presets. Omit for personal-assistant and custom agents.' },
        strategyPreset: { type: 'string', enum: ['momentum', 'momentum-position', 'range', 'swing', 'scalper', 'contrarian'], description: 'Strategy preset. ONLY for trading presets. Omit for non-trading agents.' },
        selectedConnectionId: { type: 'string', description: 'Connection ID to assign to the agent. Omission is safe only when the backend can resolve a single compatible connection deterministically from surfaced context (same-turn created or recommended connection, or a single compatible connection from the current thread). When the user is choosing among multiple compatible connections, ask which one to use rather than guessing.' },
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
        authorizationMode: {
          type: 'string',
          enum: ['direct', 'approval_required'],
          description: "Trade execution authorization policy. ONLY for trading presets. Omit for non-trading agents. 'direct' means the agent executes trades automatically. 'approval_required' means the agent asks for approval before each trade. Default: 'direct'.",
        },
      },
      required: ['skillPresetId'],
    },
  },
];

export const GuidedSetupCreateAgentInput = z.object({
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
  authorizationMode: z.enum(['direct', 'approval_required']).optional(),
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

// ── Connection Resolution ────────────────────────────────────────────────────

/**
 * Resolve the effective connection ID for a create_agent call when the model
 * omitted selectedConnectionId. Only resolves from surfaced context — never
 * performs a blind database lookup for unsurfaced connections.
 *
 * Resolution precedence:
 * 1. explicit selectedConnectionId from the model
 * 2. same-turn create_connection result
 * 3. same-turn list_compatible_connections.recommended
 * 4. thread metadata summary.connectionIds
 *
 * Each resolution tier also validates compatibility (trading agent → trading
 * connection, non-trading agent → non-trading connection).
 */
export async function resolveCreateAgentConnection(
  selectedConnectionId: string | undefined,
  preset: string,
  context: GuidedSetupResolvedConnectionContext,
  db: Database,
  userId: string,
): Promise<{ connectionId: string | undefined; error: string | undefined }> {
  const isTradingPreset = ['trading', 'direct-trading', 'trading-assistant'].includes(preset);

  // Tier 1: explicit selectedConnectionId from the model
  if (selectedConnectionId) {
    // Validate compatibility: query the DB to confirm the explicit connection
    // matches the agent type expectation.
    const [conn] = await db
      .select({
        id: connections.id,
        resolvedVenueAccountId: connections.resolvedVenueAccountId,
      })
      .from(connections)
      .where(and(eq(connections.id, selectedConnectionId), eq(connections.userId, userId), eq(connections.status, 'active')))
      .limit(1);
    if (!conn) {
      return { connectionId: undefined, error: JSON.stringify({ error: 'connection_not_found', message: `Connection ${selectedConnectionId} not found or not active.` }) };
    }
    const isTradingConn = conn.resolvedVenueAccountId !== null;
    if (isTradingPreset && !isTradingConn) {
      return { connectionId: undefined, error: JSON.stringify({ error: 'connection_incompatible', message: `Connection ${selectedConnectionId} is not a trading venue — trading agents require an exchange or DEX connection.` }) };
    }
    if (!isTradingPreset && isTradingConn) {
      return { connectionId: undefined, error: JSON.stringify({ error: 'connection_incompatible', message: `Connection ${selectedConnectionId} is a trading venue — non-trading agents should use a service connection (e.g. Gmail).` }) };
    }
    return { connectionId: selectedConnectionId, error: undefined };
  }

  // Helper: validate a surfaced connection ID against the agent type expectation.
  const validateSurfacedConnections = async (candidateIds: string[]): Promise<{ connectionId: string | undefined; error: string | undefined }> => {
    if (candidateIds.length === 0) return { connectionId: undefined, error: undefined };

    const connRows = await db
      .select({
        id: connections.id,
        resolvedVenueAccountId: connections.resolvedVenueAccountId,
        label: connections.label,
        provider: connections.provider,
      })
      .from(connections)
      .where(and(eq(connections.userId, userId), eq(connections.status, 'active')));

    const compatible = connRows.filter((r) => {
      const isTradingConn = r.resolvedVenueAccountId !== null;
      return isTradingPreset ? isTradingConn : !isTradingConn;
    });

    const matchingIds = candidateIds.filter((id) => compatible.some((c) => c.id === id));

    if (matchingIds.length === 1) {
      return { connectionId: matchingIds[0], error: undefined };
    }
    if (matchingIds.length > 1) {
      return {
        connectionId: undefined,
        error: JSON.stringify({
          error: 'connection_ambiguous',
          message: 'Multiple compatible connections are available. Please specify which one to use.',
          connections: compatible.filter((c) => matchingIds.includes(c.id)).map((c) => ({
            id: c.id,
            label: c.label,
            provider: c.provider,
          })),
        }),
      };
    }
    return { connectionId: undefined, error: undefined };
  };

  // Tier 2: same-turn create_connection result (last created)
  const tier2Result = await validateSurfacedConnections(
    context.createdConnectionIds.length > 0 ? [context.createdConnectionIds[context.createdConnectionIds.length - 1]!] : [],
  );
  if (tier2Result.connectionId || tier2Result.error) return tier2Result;

  // Tier 3: same-turn list_compatible_connections.recommended (last recommended)
  const tier3Result = await validateSurfacedConnections(
    context.recommendedConnectionIds.length > 0 ? [context.recommendedConnectionIds[context.recommendedConnectionIds.length - 1]!] : [],
  );
  if (tier3Result.connectionId || tier3Result.error) return tier3Result;

  // Tier 4: thread metadata summary.connectionIds
  const threadConnectionIds = context.threadConnectionIds;
  const tier4Result = await validateSurfacedConnections(threadConnectionIds);
  if (tier4Result.connectionId || tier4Result.error) return tier4Result;

  // No connection resolvable — not an error, just no autowiring
  return { connectionId: undefined, error: undefined };
}

// ── Action Execution ─────────────────────────────────────────────────────────

export async function executeChatAction(
  toolCall: LlmToolCall,
  db: Database,
  userId: string,
  _providersYaml: ProvidersYaml,
  usageBillingRepo: UsageBillingRepository | undefined = undefined,
  modelDefaults: ModelDefaults | undefined = undefined,
  plansConfig: PlansConfig | undefined = undefined,
  agentRiskDefaults: AgentRiskDefaultsConfig | undefined = undefined,
  venues: AppConfig['venues'] = {},
): Promise<string> {
  switch (toolCall.name) {
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

    case 'create_connection': {
      const args = (toolCall.args ?? {}) as Record<string, unknown>;
      const provider = typeof args.provider === 'string' ? args.provider : null;
      const label = typeof args.label === 'string' ? args.label : null;
      const capability = typeof args.capability === 'string' ? args.capability : null;
      const credentialMode = typeof args.credentialMode === 'string' ? args.credentialMode : null;

      if (!provider) {
        return JSON.stringify({
          error: 'validation_error',
          message: 'provider is required.',
        });
      }

      if (credentialMode !== 'generated') {
        return JSON.stringify({
          error: 'validation_error',
          message: 'create_connection only supports credentialMode: generated. Use request_connection_form for manual credentials.',
        });
      }

      // Validate provider is known and not deprecated
      const known = listProviderRegistry().find((entry) => entry.id === provider);
      if (!known || known.status === 'deprecated') {
        return JSON.stringify({
          error: 'validation_error',
          message: `Unknown or deprecated provider: ${provider}`,
        });
      }

      // Derive label server-side when the model omits it
      const effectiveLabel = label ?? `${known.displayName} Wallet`;

      // Look up user plan and admin status for plan-limit enforcement
      const [userRow] = await db
        .select({ planId: users.planId, isAdmin: users.isAdmin })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      const result = await createProviderLink(db, plansConfig, { venues, generateWallet }, {
        userId,
        userPlanId: userRow?.planId ?? 'free',
        isAdmin: userRow?.isAdmin ?? false,
        provider,
        label: effectiveLabel,
        capability: capability === 'trading' ? 'trading' : undefined,
        credentialMode: 'generated',
        secrets: undefined,
      });

      if (result.kind === 'ok') {
        const response: Record<string, unknown> = {
          success: true,
          connectionId: result.connectionId,
          provider: result.provider,
          label: result.label,
        };
        if (result.wallet) {
          const walletCap = getProviderWalletGenerationCapability(provider, venues);
          response.wallet = {
            address: result.wallet.address,
            network: result.wallet.network,
            fundingInstructionId: walletCap?.fundingInstructionId ?? `${provider}-mainnet`,
            custodyMode: 'direct' as const,
          };
        }
        return JSON.stringify(response);
      }

      if (result.kind === 'limit') {
        return JSON.stringify({
          error: result.error.code,
          message: result.error.message,
        });
      }

      if (result.kind === 'validation') {
        const primary = result.errors[0];
        return JSON.stringify({
          error: 'validation_error',
          message: primary ? `${primary.field}: ${primary.message}` : 'Invalid connection configuration.',
          details: result.errors,
        });
      }

      return JSON.stringify({
        error: result.kind === 'error' || result.kind === 'fault' ? result.code : 'setup.provider_link_failed',
        message: result.kind === 'error' || result.kind === 'fault' ? result.message : 'Failed to create connection. Please try the manual form instead.',
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
      // Backward-compat: legacy trading-assistant preset defaults to approval_required
      // when no explicit authorizationMode is provided.
      const effectiveAuthorizationMode = parsed.data.authorizationMode
        ?? (parsed.data.skillPresetId === 'trading-assistant' ? 'approval_required' : undefined);
      const authorizationModeProvided = parsed.data.authorizationMode !== undefined
        || parsed.data.skillPresetId === 'trading-assistant';
      const authorizationMode = resolveAuthorizationMode({
        skillIds,
        submittedAuthorizationMode: effectiveAuthorizationMode,
        authorizationModeProvided,
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
        if (connectionIds.length > 0) {
          result.assignedConnectionId = connectionIds[0];
        }
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
  resumeEvent: OnboardingResumeEvent | undefined = undefined,
  usageBillingRepo: UsageBillingRepository | undefined = undefined,
  modelDefaults: ModelDefaults | undefined = undefined,
  plansConfig: PlansConfig | undefined = undefined,
  agentRiskDefaults: AgentRiskDefaultsConfig | undefined = undefined,
  venues: AppConfig['venues'] = {},
): Promise<LlmInvocationResult> {
  // Select the right prompt based on the preset the user chose
  const preset = threadMetadata?.summary?.preset;
  const systemPrompt = preset === 'trading' ? buildTradingPrompt()
    : preset === 'personal-assistant' ? buildPersonalAssistantPrompt()
    : preset === 'custom' ? buildCustomPrompt()
    : buildBasePrompt();

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
  const resolvedConnections: GuidedSetupResolvedConnectionContext = {
    createdConnectionIds: [],
    recommendedConnectionIds: [],
    threadConnectionIds: threadMetadata?.summary?.connectionIds ?? [],
  };

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
        content: `I'm having trouble processing your request right now. Please try again or use the [form](/agents/new) instead. (Error: ${result.error.message})`,
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
      // ── Connection autowiring: resolve before dispatching create_agent ──
      if (tc.name === 'create_agent') {
        const args = (tc.args ?? {}) as Record<string, unknown>;
        const preset = typeof args.skillPresetId === 'string' ? args.skillPresetId : '';
        const existingSelectedId = typeof args.selectedConnectionId === 'string' ? args.selectedConnectionId : undefined;

        const resolution = await resolveCreateAgentConnection(
          existingSelectedId,
          preset,
          resolvedConnections,
          db,
          userId,
        );

        if (resolution.error) {
          // Return the resolution error as a tool result so the LLM can handle it.
          toolResults.push({
            role: 'tool',
            content: resolution.error,
            toolCallId: tc.id,
            toolName: tc.name,
            addedAtTurn: round,
          });
          toolCallsProcessed++;

          // ── Connection disambiguation buttons ──────────────────────────
          // When multiple compatible connections exist and the model omitted
          // selectedConnectionId, emit rendered quick_replies buttons so the
          // user can tap a connection instead of typing a label.
          try {
            const errParsed = JSON.parse(resolution.error) as Record<string, unknown>;
            if (errParsed.error === 'connection_ambiguous' && Array.isArray(errParsed.connections)) {
              const conns = errParsed.connections as Array<{ id: string; provider: string; label: string }>;
              const venueHint = threadMetadata?.summary?.venue;
              const choiceActions = buildConnectionChoiceActions(conns, venueHint);
              // Make the action id unique per round
              for (const a of choiceActions) {
                a.id = `connection-choice-${round}`;
              }
              pendingActions.push(...choiceActions);
            }
          } catch {
            // Non-JSON error content — skip button emission
          }

          continue;
        }

        // If we resolved a connection that the model omitted, rewrite tc.args
        // so executeChatAction sees it.
        if (!existingSelectedId && resolution.connectionId) {
          tc.args = { ...tc.args, selectedConnectionId: resolution.connectionId };
        }
      }

      // ── Dispatch tool call with error guard ──
      let toolResult: string;
      try {
        toolResult = await executeChatAction(tc, db, userId, providersYaml, usageBillingRepo, modelDefaults, plansConfig, agentRiskDefaults, venues);
      } catch (err) {
        toolResult = JSON.stringify({
          error: 'tool_execution_failed',
          message: err instanceof Error ? err.message : 'Tool execution failed',
        });
      }
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

      // Emit a wallet funding guidance card when create_connection succeeds
      // with a generated wallet, so the frontend can render it prominently.
      if (tc.name === 'create_connection') {
        try {
          const parsed = JSON.parse(toolResult) as Record<string, unknown>;
          if (parsed.success && parsed.connectionId) {
            resolvedConnections.createdConnectionIds.push(parsed.connectionId as string);
            summaryFacts.connectionIds = [...(summaryFacts.connectionIds ?? []), parsed.connectionId as string];
          }
          // Capture the venue (provider) for venue-filtered disambiguation buttons
          if (parsed.success && parsed.provider && typeof parsed.provider === 'string') {
            summaryFacts.venue = parsed.provider;
          }
          if (parsed.success && parsed.wallet && typeof parsed.wallet === 'object') {
            const wallet = parsed.wallet as Record<string, unknown>;
            pendingActions.push({
              id: `wallet-funding-${round}`,
              type: 'confirm',
              props: {
                type: 'wallet_created',
                provider: parsed.provider,
                connectionId: parsed.connectionId,
                walletAddress: wallet.address,
                network: wallet.network,
                fundingInstructionId: wallet.fundingInstructionId,
                custodyMode: wallet.custodyMode,
              },
            });
          }
        } catch {
          // Non-JSON tool result — no wallet to render
        }
      }

      // Extract structured facts from tool results
      try {
        const parsed = JSON.parse(toolResult) as Record<string, unknown>;
        if (tc.name === 'list_compatible_connections' && parsed.recommended && typeof parsed.recommended === 'object') {
          const rec = parsed.recommended as Record<string, unknown>;
          if (rec.id) {
            resolvedConnections.recommendedConnectionIds.push(rec.id as string);
            summaryFacts.connectionIds = [...(summaryFacts.connectionIds ?? []), rec.id as string];
          }
          // Capture the venue (provider) from the recommended connection so
          // disambiguation buttons can be venue-filtered.
          if (rec.provider && !summaryFacts.venue) {
            summaryFacts.venue = rec.provider as string;
          }
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
          if (parsed.assignedConnectionId) {
            const existing = summaryFacts.connectionIds ?? [];
            summaryFacts.connectionIds = [...existing, parsed.assignedConnectionId as string];
          }
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
  usageBillingRepo: UsageBillingRepository | undefined = undefined,
  chatUsageBillingRecorder: ChatUsageBillingRecorder | undefined = undefined,
  modelDefaults: ModelDefaults | undefined = undefined,
  plansConfig: PlansConfig | undefined = undefined,
  agentRiskDefaults: AgentRiskDefaultsConfig | undefined = undefined,
  venues: AppConfig['venues'] = {},
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

      // ── Detect connection-choice button replies ────────────────────────
      // When the user taps a connection-choice quick_reply button, the
      // frontend sends the structured value as the message content.
      // Process it before invoking the LLM so we can update thread metadata
      // and resume with the right context.
      let effectiveMetadata = metadata;
      let effectiveResumeEvent: OnboardingResumeEvent | undefined;

      const trimmedContent = content.trim();
      if (BUTTON_VALUE_RE.test(trimmedContent)) {
        if (trimmedContent.startsWith('connection:')) {
          const connectionId = trimmedContent.slice('connection:'.length);
          // Look up the connection's provider for venue re-derivation
          let providerHint: string | undefined;
          try {
            const [conn] = await db
              .select({ provider: connections.provider })
              .from(connections)
              .where(and(eq(connections.id, connectionId), eq(connections.userId, request.userId)))
              .limit(1);
            providerHint = conn?.provider;
          } catch {
            // Non-critical — proceed without provider hint
          }

          // Re-derive venue-coupled config: if the selected connection's
          // provider differs from the previously assumed venue, update venue
          // and clear the preset so the LLM re-derives it.
          const existingVenue = metadata?.summary?.venue;
          const venueChanged = providerHint && existingVenue && providerHint !== existingVenue;

          effectiveMetadata = {
            ...(metadata ?? {}),
            summary: {
              ...(metadata?.summary ?? {}),
              connectionIds: [connectionId],
              step: 'connection_selected',
              ...(venueChanged ? { venue: providerHint, preset: undefined } : {}),
            },
          };

          effectiveResumeEvent = {
            kind: 'connection_selected',
            connectionId,
            providerHint,
            actionContext: 'guided_setup_connection',
          };
        } else if (trimmedContent === 'action:create_connection') {
          effectiveMetadata = {
            ...(metadata ?? {}),
            summary: {
              ...(metadata?.summary ?? {}),
              step: 'create_connection_requested',
            },
          };
          // No special resume event — the LLM has full context and knows it
          // needs to call create_connection for the venue in play.
        } else if (trimmedContent === 'action:request_connection_form') {
          effectiveMetadata = {
            ...(metadata ?? {}),
            summary: {
              ...(metadata?.summary ?? {}),
              step: 'connection_form_requested',
            },
          };
        }

        // Persist updated metadata immediately so the resumed LLM sees it.
        await db.update(chatThreads)
          .set({
            metadata: effectiveMetadata as Record<string, unknown>,
            updatedAt: now(),
          })
          .where(eq(chatThreads.id, request.params.id));
      }

      // Detect preset from the user's message so prompt routing works on the
      // first turn after the user taps a preset button. Also handles mid-thread
      // preset switching.
      const detectedPreset = detectPresetFromContent(content);
      if (detectedPreset) {
        effectiveMetadata = {
          ...(effectiveMetadata ?? {}),
          summary: { ...(effectiveMetadata?.summary ?? {}), preset: detectedPreset },
        };
      }

      // Invoke onboarding LLM
      const llmResponse = await invokeOnboardingLlm(
        llmConfig,
        providersYaml,
        db,
        request.userId,
        allMessages,
        effectiveMetadata,
        effectiveResumeEvent,
        usageBillingRepo,
        modelDefaults,
        plansConfig,
        agentRiskDefaults,
        venues,
      );

      // Record chat LLM usage for billing (fire-and-forget)
      const billingUsage = llmResponse.billingUsage;
      if (chatUsageBillingRecorder && billingUsage && billingUsage.tokensUsed > 0) {
        void chatUsageBillingRecorder.record({
          userId: request.userId,
          threadId: request.params.id,
          billingAnchorId: userMsgId,
          phase: 'message_send',
          usage: billingUsage,
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
      const metadataUpdate: ThreadMetadata = {
        ...(effectiveMetadata ?? {}),
        ...(llmResponse.createdAgent ? {
          createdAgentId: llmResponse.createdAgent.agentId,
          completedAt: new Date().toISOString(),
        } : {}),
        summary: {
          ...(effectiveMetadata?.summary ?? {}),
          ...(llmResponse.summaryFacts ?? {}),
          // Persist the preset when determinable so resumed turns (e.g. after
          // Gmail OAuth) retain the active setup type without re-deriving it.
          ...(detectedPreset ? { preset: detectedPreset } : {}),
          step: llmResponse.createdAgent ? 'completed' : (effectiveMetadata?.summary?.step ?? 'conversation'),
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
        venues,
      );

      // Record chat LLM usage for billing (fire-and-forget)
      const billingUsage = llmResponse.billingUsage;
      if (chatUsageBillingRecorder && billingUsage && billingUsage.tokensUsed > 0) {
        void chatUsageBillingRecorder.record({
          userId: request.userId,
          threadId: request.params.id,
          billingAnchorId: actionId,
          phase: 'action_result',
          usage: billingUsage,
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
