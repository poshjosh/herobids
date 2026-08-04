# Plan: Guided Agent Creation (Onboarding Chat)

**Feature:** AI-First UX (005)
**Date:** 2026-08-01
**Status:** Draft

## Summary

Implement a chat-based **Guided Setup** experience on the agent creation page. New users interact with an LLM agent that guides them conversationally through creating their first AI agent — asking follow-up questions, resolving presets, applying happy-path defaults for most fields, and calling `POST /agents` when ready. The chat is an **alternate (preferred) route** alongside the existing form; it does not replace the form. Embedded forms handle secrets (connections, wallets) so sensitive data never transits through the LLM.

**v1 scope:** Single-purpose — guide users through the create-agent workflow. General chat ("ask anything," brainstorming, research) is deferred. The UI label is **Guided Setup**.

## Relationship to Existing Product Spec

This plan delivers the **first step** toward the general-purpose Chat With AI surface defined in `docs/product/chat-with-ai/product-ux-spec.md`. It reuses only the narrow pieces needed for onboarding (thread persistence, platform-docs access, secure form rendering, and a restricted API-local tool-calling loop) and is scoped to one workflow: agent creation. The product spec describes where we're going; v1 is the first delivery.

In v1, the chat is:

- Embedded on the agent creation / onboarding page (not a separate sidebar item or `/chat` route)
- Single-purpose: guide through create-agent (not "ask anything")
- Labeled **Guided Setup** in the UI (not "Chat With AI" yet)
- An alternate route alongside the form — the form is always available as fallback

## Architecture

```
┌──────────┐     POST /chat/threads/:id/messages     ┌───────────┐
│  Web UI  │ ──────────────────────────────────────→ │  API      │
│  (React) │ ←── SSE or JSON response ────────────── │  (Fastify)│
└──────────┘                                         └─────┬─────┘
                                                           │
                                                    ┌──────▼──────┐
                                                    │  Chat Agent │
                                                    │  Runtime    │
                                                    │             │
                                                    │ Context:    │
                                                    │ - platform- │
                                                    │   docs      │
                                                    │ - thread    │
                                                    │   summary   │
                                                    │             │
                                                    │ Actions:    │
                                                    │ - *_app_docs│
                                                    │ - list_user_│
                                                    │   connections│
                                                    │ - create_   │
                                                    │   agent     │
                                                    └─────────────┘
```

### Key Design Decisions

1. **Chat is an alternate (preferred) route, not a replacement for forms.** Every field in `CreateAgentSchema` remains accessible via the existing form. The chat covers the happy path (~6-8 key fields). Edge-case fields stay form-only. The form is the authoritative fallback — always one click away.

2. **Chat threads are separate from agent runtimes.** The guided setup agent is not a persistent AI Employee — it's a stateless (or session-scoped) LLM agent invoked per message. This avoids continuous runtime billing for onboarding.

3. **Guided Setup uses a narrow API-local tool-calling runtime.** It does NOT reuse the simple one-shot pattern from `apps/api/src/routes/ai.ts`, and it does NOT run on the worker agent runtime. The API hosts a restricted onboarding loop: provide context, expose a small allowlist of onboarding actions, execute them server-side, and return a final assistant response.

4. **The onboarding runtime exposes chat-safe actions, not worker runtime tools.** The chat runtime may expose API-local actions such as `search_app_docs`, `list_app_docs`, `read_app_docs`, `list_compatible_connections`, and `create_agent`. It must not pretend that worker-only tools like `send_message` or runtime `list_connections` are available.

5. **Secure setup is rendered via backend-owned structured actions.** When the chat agent determines a connection is needed, the onboarding runtime returns a structured `actions` payload for the frontend to render inline. On success, the frontend sends the resulting `connectionId` back to the chat via the action-result endpoint. The LLM never sees private keys, API secrets, or OAuth tokens.

6. **Scoped to create-agent for v1.** General chat ("ask anything," brainstorming, research) is NOT in v1. The greeting is honest about scope. The UI label is **Guided Setup** — not "Chat With AI."

7. **Embedded on the agent creation page, not a separate route.** New users (0 agents) land on Guided Setup with a "Use the form instead" link. Returning users see a tab choice: "Guided (Chat)" | "Form" when they navigate to "New Agent." No sidebar item, no `/chat` route in v1.

8. **Thread history uses persisted user/assistant messages plus separate internal summary state.** Each message invocation sends the last 20 persisted user/assistant messages plus a structured thread summary (key facts: selected preset, venue, capital, connection IDs collected) loaded from thread metadata or a separate internal state store. The summary is updated after each tool call or key decision point, but it is not persisted as a chat message.

9. **One agent per thread in v1.** A Guided Setup thread creates at most one agent. After creation, the thread remains viewable for confirmation and follow-up context, but "Create another agent" starts a new thread.

10. **Redirect/resume is the baseline OAuth model for v1.** Reuse the current create-agent draft preservation and `oauthReturn` resume pattern. Popup OAuth is optional later work after provider-specific validation.

11. **Guided Setup offers a strong happy path with system-selected defaults.** In the default flow, the user must explicitly choose the agent type/preset and specify capital. The system decides most other fields unless the user overrides them: generate the name with the same algorithm used by the existing create-agent form, default the goal/prompt to a configurable platform value (initial default: "Grow this portfolio"), default style to `balanced`, default the user-facing execution choice to `test` and map it server-side to canonical `executionDefaults`, choose a strategy preset automatically, and auto-assign a server-resolved compatible existing active connection when one is available.

## Scope

### In Scope

- New API endpoints (minimal: create thread, fetch thread, send message, submit action result; no listing, renaming, or deletion in v1)
- Narrow API-local onboarding runtime (invoked per-message, not continuously ticking)
- Frontend chat component embedded on the agent creation page with:
  - Message list (user + assistant)
  - Composer (text input, send button)
  - Quick-reply buttons (for preset selection)
  - Embedded form injection for secrets
  - Agent creation progress indicator
  - "Use the form instead" escape hatch
- Greeting message with i18n support, honest about scope (no "ask anything")
- Post-creation follow-up messages (fund wallet reminder, test mode notice)
- Agent creation via `create_agent` tool
- Chat thread persistence (history survives page reload)
- DB schema: `chat_threads` + `chat_messages` (persist only replayable user/assistant messages; summaries live in metadata or separate internal state)

### Out of Scope (v1)

- General chat ("ask anything," brainstorming, research, summarization)
- Continuous background chat agent (it's invoked per message)
- Chat with running agents (that's agent interactivity, already exists)
- Sidebar item, `/chat` route, or standalone chat page
- Thread listing, renaming, or deletion UI
- File uploads in chat
- Voice input
- Multi-user chat threads
- Telegram `/chat` command — Telegram bot commands remain agent-operational only
- Public website chat widget (marketing site) — separate feature involving unauthenticated access

## Implementation Steps

### Step 1: Database Schema — Chat Threads & Messages

New Drizzle tables in `packages/db/src/schema/`:

```typescript
// chat_threads
export const chatThreads = pgTable('chat_threads', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  title: text('title'),  // auto-generated from first message
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  metadata: jsonb('metadata'),  // { createdAgentId?: string, completedAt?: string, presetSelected: string, summary: { preset, venue, capital, connectionIds, ... } }
});

// chat_messages
export const chatMessages = pgTable('chat_messages', {
  id: text('id').primaryKey(),
  threadId: text('thread_id').notNull().references(() => chatThreads.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),  // 'user' | 'assistant'
  // Plain persisted visible chat text. v1 must warn users not to paste secrets;
  // it does not promise automatic redaction or message-level encryption.
  content: text('content').notNull(),
  /** Structured actions: form renders, agent creation confirmations, etc. */
  actions: jsonb('actions'),  // [{ type: 'form', form: 'connection', props: {...} }, ...]
  /** Tokens used for this message (for cost tracking) */
  usage: jsonb('usage'),  // { inputTokens, outputTokens, costUsd }
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Note: structured summaries and other hidden workflow state live in
// chat_threads.metadata (or a separate internal store), not as chat_messages rows.
```

### Step 2: API Endpoints

Minimal routes in a new file `apps/api/src/routes/chat.ts`:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/chat/threads` | Create a new thread and return the initial greeting |
| `GET` | `/chat/threads/:id` | Get one onboarding thread with persisted messages |
| `POST` | `/chat/threads/:id/messages` | Send a user message, get assistant response |
| `POST` | `/chat/threads/:id/actions/:actionId` | Submit a form action result (e.g., connection created) |

**Key endpoint: `POST /chat/threads/:id/messages`**

1. Validate the user message
2. Load thread context:
  - Last 20 persisted user/assistant messages (sliding window)
  - Structured thread summary from metadata/internal state (selected preset, venue, capital, connection IDs, creation status)
3. Invoke the narrow onboarding runtime with:
  - System prompt (onboarding-focused, includes schema constraints)
  - Non-persisted internal summary/context block
  - Last 20 messages
  - Available chat-safe actions: `search_app_docs`, `list_app_docs`, `read_app_docs`, `list_compatible_connections`, `create_agent`
4. If the LLM returns an action call, execute it server-side
5. If the action is `create_agent`: validate the payload against the guided-setup input schema, derive the full `CreateAgentSchema` payload server-side, create the agent, mark the thread completed, and return success with the agent ID + post-creation context
6. If the runtime determines the UI must render a form, quick replies, or a confirmation card, normalize that into structured `actions` in the response
7. Return the assistant message with any actions

### Step 3: Chat Agent System Prompt

```
You are a Guided Setup assistant for OpenAIdom, a platform for creating and running AI agents.

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
- If the user does not ask for a specific style, use `balanced`.
- If the user does not ask for a specific execution mode, use the user-facing `test` choice. The server maps that to canonical `executionDefaults.mode`.
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
- The synthesized prompt/goal must appear in the confirmation summary before `create_agent` runs.

### Rules:
- You are single-purpose: create agents. Nothing else.
- Never ask for private keys, API secrets, or passwords.
- When the user needs to connect a wallet or exchange, request the secure connection form action so the frontend renders the appropriate setup UI.
- Always validate your understanding before calling create_agent.
- After creating, remind the user of important next steps.
- The user can always say "skip" or "use the form" to switch to the form-based flow.
- Cover the happy path (~6-8 key fields). Advanced settings are in the form.
```

### Step 4: Frontend Chat Component

New component tree under `apps/web/src/features/chat/`:

```
chat/
  GuidedSetupPanel.tsx    # Embedded create-agent chat surface
  GuidedSetupThread.tsx   # Message list + composer
  ChatMessage.tsx         # Single message (user or assistant)
  ChatComposer.tsx        # Text input + send
  ChatQuickReplies.tsx    # Button row for preset/suggestion selection
  GuidedSetupActionRenderer.tsx # Renders structured chat actions inline
  GuidedSetupGreeting.tsx # Initial greeting message with preset buttons
  useGuidedSetup.ts       # Hook: thread fetch/send/resume state
```

**Greeting message** (i18n key: `chat.onboarding.greeting`):

The greeting is NOT hardcoded in the frontend. It's sent as the first assistant message when a new thread is created. The greeting must be honest about scope — no "ask anything."

```json
{
  "role": "assistant",
  "content": "Hi! I can help you create an AI agent. What kind of agent are you looking for?",
  "actions": [
    { "type": "quick_replies", "options": [
      { "label": "AI crypto trader", "value": "preset:trading" },
      { "label": "AI personal assistant", "value": "preset:personal-assistant" },
      { "label": "Custom AI", "value": "preset:custom" }
    ]}
  ]
}
```

The preset labels come from existing i18n keys (e.g., `agents.skillPresetId.trading`, `agents.skillPresetId.personal-assistant`).

### Step 5: Embedded Action System

The backend returns structured chat actions alongside assistant text. Assistant `content` is display-only; the frontend must not parse assistant text for commands.

```json
{
  "role": "assistant",
  "content": "I found a compatible trading connection. Want to use it, or connect a different one?",
  "actions": [
    {
      "id": "action-1",
      "type": "quick_replies",
      "options": [
        { "label": "Use recommended connection", "value": "use_connection:conn_123" },
        { "label": "Connect a different account", "value": "open_connection_form" }
      ]
    },
    {
      "id": "action-2",
      "type": "form",
      "form": "connection",
      "props": { "venue": "hyperliquid" }
    }
  ]
}
```

The frontend renders these actions inline:

- `form` → renders the appropriate secure setup UI inline in the chat
- `quick_replies` → renders button choices
- `confirm` → renders the agent creation confirmation card
- On success → the frontend posts the result to `/chat/threads/:id/actions/:actionId`
- The chat runtime records the result in internal summary state and continues

Trading and wallet setup must reuse the existing secure setup orchestration via `POST /setup/provider-link`. Email setup must reuse the existing OAuth connection flow. Guided Setup must not invent a separate provisioning path.

This is safer than the LLM trying to render HTML forms (which it would hallucinate). The runtime decides *when* to show a form and *which type*; the frontend owns the actual form rendering and secret handling.

**Form types to support in v1:**

| Action payload | Form Component | Purpose |
|--------|---------------|---------|
| `{ type: 'form', form: 'connection', props: { venue: 'hyperliquid' } }` | Reused trading setup form | Calls `POST /setup/provider-link` for trading setup |
| `{ type: 'form', form: 'connection', props: { venue: 'jupiter' } }` | Reused trading setup form | Calls `POST /setup/provider-link` for wallet provisioning |
| `{ type: 'form', form: 'connection', props: { type: 'email' } }` | Reused email OAuth flow | Calls existing `/connections/oauth/*` flow |

### Step 6: create_agent Action (Chat-Specific)

This is a **separate onboarding action** from worker tools like `create_bot`. It runs in the API context (not the worker), because:

- It needs access to the HTTP request context (user auth)
- It creates agents, not bots
- It's only available to the onboarding chat agent

The action implementation in `apps/api/src/routes/chat.ts`:

```typescript
const GuidedSetupCreateAgentInput = z.object({
  skillPresetId: z.enum(['trading', 'direct-trading', 'trading-assistant', 'personal-assistant', 'custom']),
  capital: z.string().min(1),
  goal: z.string().optional(),
  style: z.enum(['careful', 'balanced', 'bold']).optional(),
  requestedExecutionMode: z.enum(['test', 'live']).optional(),
  strategyPreset: z.enum(['momentum', 'momentum-position', 'range', 'swing', 'scalper', 'contrarian']).optional(),
  selectedConnectionId: z.string().optional(),
});

const createAgentAction = {
  name: 'create_agent',
  description: 'Create a new AI agent with the specified configuration.',
  parametersSchema: GuidedSetupCreateAgentInput,
  async execute(params, ctx) {
    // Validate against GuidedSetupCreateAgentInput
    // Derive the full CreateAgentSchema payload server-side
    // Map requestedExecutionMode -> canonical executionDefaults.mode using
    // the same resolver as the existing create-agent form
    // Synthesize the final prompt deterministically when goal is omitted
    // Insert into agents table
    // Return agent ID + post-creation context
  }
};
```

#### Happy-path field ownership for v1

| Field | Owner | Default / Rule |
|------|-------|----------------|
| `skillPresetId` | User | User must explicitly choose the agent type/preset |
| `capital` | User | User must explicitly specify capital |
| `name` | System | Generate with the same algorithm used by the current create-agent form |
| `prompt` / goal | System | Use a configurable platform default when the user does not provide a custom goal; initial default: `Grow this portfolio` |
| `style` | System | Default to `balanced` unless the user overrides it |
| `requestedExecutionMode` | System | Default to user-facing `test` unless the user overrides it; server maps it to canonical `executionDefaults.mode` |
| `strategyPreset` | System | Auto-select one; preferred: market-regime aware, acceptable v1 fallback: deterministic platform default |
| `selectedConnectionId` | Server / User | Use the server-recommended compatible active connection when available; otherwise collect a different one through secure setup UI |
| `connectionIds` | Server | Derived from `selectedConnectionId` when building `CreateAgentSchema` |
| `skillIds` | Server | Derive from `skillPresetId`; not directly LLM-owned in v1 |

Server-owned / excluded from `GuidedSetupCreateAgentInput` in v1: `toolPolicy`, `modelPolicy`, `provider`, `lightModel`, `heavyModel`, `technical`, `runtimePolicyOverrides`, `wakePreferences`, `platformAssessment`, `tickIntervalMs`, `openPositionEscalationToJudgePolicy`, `notificationPolicy`, `authorizationMode`, `capabilityMode`, `hybridMode`, `executionDefaults`, and the final compatible-connection resolution rules.

All advanced or power-user fields remain out of the happy path and should stay form-only unless explicitly added later.

### Step 7: Post-Creation Follow-up

After `create_agent` succeeds, the chat agent receives the created agent's state:

```json
{
  "agentId": "uuid",
  "name": "My Trading Agent",
  "displayExecutionMode": "test",
  "executionDefaults": { "mode": "shadow" },
  "capital": "500",
  "venue": "hyperliquid",
  "walletAddress": "0x..."
}
```

The system prompt instructs the LLM to generate contextual reminders:

- "Your agent **My Trading Agent** is created and running in **test mode**. You can switch to live anytime from the agent settings."
- "Don't forget to fund your wallet `0x...` with at least **$500** USDC on Arbitrum."
- "You can view your agent's activity on the Agents page."

### Step 8: Navigation & Routing

- **No separate `/chat` route or sidebar item in v1.** The chat is embedded on the agent creation page.
- **New users (0 agents):** Landing page (`/`) → Guided Setup (chat) on the create-agent page, with a "Use the form instead" link to switch to the form.
- **Returning users (≥1 agent):** Landing page stays at `/agents`. When they navigate to "New Agent," they see a tab choice: **Guided (Chat)** | **Form**. Guided is the default tab.
- **Thread metadata:** `chat_threads.metadata` tracks summary state plus at most one `createdAgentId` for v1.
- **Post-creation continuity:** Completed threads remain viewable, but "Create another agent" starts a new thread.
- **Start over semantics:** "Start over" always creates a fresh thread with the greeting state. v1 does not mutate or truncate the current thread's persisted history.
- **Future:** When general Chat With AI ships, it gets its own `/chat` route and sidebar item. The Guided Setup chat is the first use of that infrastructure.

## Verification

- New user (0 agents) lands on the agent creation page, sees Guided Setup greeting with preset buttons
- Greeting is honest about scope (no "ask anything" — it's "I can help you create an AI agent")
- Clicking "AI crypto trader" starts a conversation about trading preferences
- Chat asks for the minimum required fields, especially preset and capital, and uses happy-path defaults for the rest unless the user overrides them
- If a compatible existing active connection already exists, the server recommends it and Guided Setup auto-selects it
- OAuth return and resume works with the existing redirect-based draft restoration pattern
- When connection needed, the backend returns a structured `form` action that renders inline
- After form completion, chat continues with the connection ID
- Agent created successfully via `create_agent` action
- One thread produces at most one agent in v1
- Post-creation message includes wallet address and test mode reminder
- "Use the form instead" link switches to the existing Create Agent form
- Returning user who clicks "New Agent" sees tab choice: Guided (Chat) | Form
- Guided is the default tab
- "Start over" creates a new thread and leaves the prior thread viewable

## Risks

| Risk | Mitigation |
|------|-----------|
| LLM creates agent with wrong/incomplete config | Zod validation on `create_agent` rejects bad payloads; LLM gets error and retries |
| Chat loops forever asking questions | Use operator-configured turn caps and frontend fallback thresholds; show "stuck? use the form" after the configured threshold |
| LLM cost for onboarding | Use an operator-configured low-cost onboarding model tier; track as separate cost bucket; show "powered by AI" disclosure |
| Chat not accessible without JS | Graceful fallback: the existing form-based flow remains available |
| Users confused between chat and agent messaging | Clear labeling per product spec; chat is "Chat With AI", agent comms are within agent detail pages |
