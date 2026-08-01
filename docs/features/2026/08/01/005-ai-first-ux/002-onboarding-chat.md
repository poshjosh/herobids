# Plan: Guided Agent Creation (Onboarding Chat)

**Feature:** AI-First UX (005)
**Date:** 2026-08-01
**Status:** Draft

## Summary

Implement a chat-based **Guided Setup** experience on the agent creation page. New users interact with an LLM agent that guides them conversationally through creating their first AI agent — asking follow-up questions, resolving presets, and calling `POST /agents` when ready. The chat is an **alternate (preferred) route** alongside the existing form; it does not replace the form. Embedded forms handle secrets (connections, wallets) so sensitive data never transits through the LLM.

**v1 scope:** Single-purpose — guide users through the create-agent workflow. General chat ("ask anything," brainstorming, research) is deferred. The UI label is **Guided Setup**.

## Relationship to Existing Product Spec

This plan delivers the **first step** toward the general-purpose Chat With AI surface defined in `docs/product/chat-with-ai/product-ux-spec.md`. It shares the same infrastructure (thread persistence, skills, tools, marker protocol) but is scoped to one workflow: agent creation. The product spec describes where we're going; v1 is the first delivery.

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
                                                    │ Skills:     │
                                                    │ - platform- │
                                                    │   docs      │
                                                    │ - base      │
                                                    │             │
                                                    │ Tools:      │
                                                    │ - *_app_docs│
                                                    │ - create_   │
                                                    │   agent     │
                                                    │ - list_     │
                                                    │   connections│
                                                    └─────────────┘
```

### Key Design Decisions

1. **Chat is an alternate (preferred) route, not a replacement for forms.** Every field in `CreateAgentSchema` remains accessible via the existing form. The chat covers the happy path (~6-8 key fields). Edge-case fields stay form-only. The form is the authoritative fallback — always one click away.

2. **Chat threads are separate from agent runtimes.** The guided setup agent is not a persistent AI Employee — it's a stateless (or session-scoped) LLM agent invoked per message. This avoids continuous runtime billing for onboarding.

3. **The chat agent has access to `create_agent` as a tool.** It collects information conversationally, validates it against the schema (read via `read_app_docs`), and submits `POST /agents` when ready. The API's Zod validation is the final safety net.

4. **Secrets never transit through the LLM.** When the chat agent determines a connection is needed, it emits a structured marker `[FORM:connection:venue=X]`. The frontend renders the connection form inline. On success, the frontend sends the resulting `connectionId` back to the chat. The LLM never sees private keys, API secrets, or OAuth tokens.

5. **Scoped to create-agent for v1.** General chat ("ask anything," brainstorming, research) is NOT in v1. The greeting is honest about scope. The UI label is **Guided Setup** — not "Chat With AI."

6. **Embedded on the agent creation page, not a separate route.** New users (0 agents) land on Guided Setup with a "Use the form instead" link. Returning users see a tab choice: "Guided (Chat)" | "Form" when they navigate to "New Agent." No sidebar item, no `/chat` route in v1.

7. **Thread history uses a sliding window + structured summary.** Each message invocation sends the last 20 messages plus a structured thread summary (key facts: selected preset, venue, capital, connection IDs collected). The summary is updated after each tool call or key decision point.

8. **Threads stay active after agent creation.** The user can continue the thread and create multiple agents. Thread metadata tracks `agentCreatedIds: [...]`. No special "locked" state after creation.

9. **OAuth connection flows use popup windows where possible.** For providers that support popup OAuth (most do), the connection form opens in a popup, completes in-window, and the chat never loses context. For providers that require full redirect, the OAuth redirect URL includes `?threadId=X`. A technical spike is needed.

## Scope

### In Scope

- New API endpoints (minimal: create thread + send message; no listing, renaming, or deletion in v1)
- Chat agent runtime (lightweight, invoked per-message, not continuously ticking)
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
- DB schema: `chat_threads` + `chat_messages` (forward-looking, but only core endpoints built)

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
  metadata: jsonb('metadata'),  // { agentCreatedIds: string[], presetSelected: string, summary: { preset, venue, capital, connectionIds, ... } }
});

// chat_messages
export const chatMessages = pgTable('chat_messages', {
  id: text('id').primaryKey(),
  threadId: text('thread_id').notNull().references(() => chatThreads.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),  // 'user' | 'assistant' | 'system'
  content: text('content').notNull(),
  /** Structured actions: form renders, agent creation confirmations, etc. */
  actions: jsonb('actions'),  // [{ type: 'form', form: 'connection', props: {...} }, ...]
  /** Tokens used for this message (for cost tracking) */
  usage: jsonb('usage'),  // { inputTokens, outputTokens, costUsd }
  createdAt: timestamp('created_at').defaultNow().notNull(),
});
```

### Step 2: API Endpoints

All routes in a new file `apps/api/src/routes/chat.ts`:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/chat/threads` | List user's chat threads |
| `POST` | `/chat/threads` | Create a new thread (optionally with first message) |
| `GET` | `/chat/threads/:id` | Get a thread with messages |
| `DELETE` | `/chat/threads/:id` | Delete a thread |
| `POST` | `/chat/threads/:id/messages` | Send a user message, get assistant response |
| `POST` | `/chat/threads/:id/actions/:actionId` | Submit a form action result (e.g., connection created) |

**Key endpoint: `POST /chat/threads/:id/messages`**

1. Validate the user message
2. Load thread context:
   - Last 20 messages (sliding window)
   - Structured thread summary (auto-generated after each tool call or key decision: selected preset, venue, capital, connection IDs, created agent IDs)
3. Invoke the chat LLM agent with:
   - System prompt (onboarding-focused, includes schema constraints)
   - Thread summary (injected as a system message)
   - Last 20 messages
   - Available tools: `search_app_docs`, `list_app_docs`, `read_app_docs`, `create_agent`, `list_connections`, `send_message`
4. If the LLM returns a tool call, execute it server-side
5. If the tool call is `create_agent`: validate the payload against `CreateAgentSchema`, create the agent, return success with the agent ID + post-creation context
6. If the LLM returns text with `[FORM:...]` markers, include them as structured `actions` in the response
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

You can create an agent directly using the create_agent tool when you have enough information.

## Greeting

When starting, say something like:

"Hi! I can help you create an AI agent. What kind of agent are you looking for?"

Then offer the available presets as quick-reply buttons (trading, personal assistant, custom).
Do NOT say "ask anything" — you have a specific job.

## Conversation Flow

### If the user wants a trading agent:
1. Ask what they want to trade (any specific tokens, sectors, or strategies?)
2. Ask what chain they use (Ethereum, Solana, or any?)
3. Ask about their risk comfort (careful, balanced, or bold?)
4. Ask about capital (how much do they want to allocate?)
5. Ask if they have an existing wallet/connection or need to create one
6. Summarize and confirm before creating

### If the user wants a personal assistant:
1. Ask what kind of help they need (tasks, email, research?)
2. Determine which skills to enable
3. Ask about notification preferences
4. Summarize and confirm before creating

### Rules:
- You are single-purpose: create agents. Nothing else.
- Never ask for private keys, API secrets, or passwords.
- When the user needs to connect a wallet or exchange, emit [FORM:connection:venue=X] 
  so the frontend renders the secure connection form.
- Always validate your understanding before calling create_agent.
- After creating, remind the user of important next steps.
- The user can always say "skip" or "use the form" to switch to the form-based flow.
- Cover the happy path (~6-8 key fields). Advanced settings are in the form.
```

### Step 4: Frontend Chat Component

New component tree under `apps/web/src/features/chat/`:

```
chat/
  ChatPage.tsx           # Main page with sidebar + thread view
  ChatSidebar.tsx        # Thread list
  ChatThread.tsx         # Message list + composer
  ChatMessage.tsx        # Single message (user or assistant)
  ChatComposer.tsx       # Text input + send
  ChatQuickReplies.tsx   # Button row for preset/suggestion selection
  EmbeddedForm.tsx       # Renders [FORM:...] actions inline
  ChatGreeting.tsx       # Initial greeting message with preset buttons
  useChat.ts             # Hook: thread management, send message, loading state
  chat-renderer.ts       # Parses LLM responses for [FORM:...] markers
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

### Step 5: Embedded Form System

The `[FORM:...]` marker protocol:

```
[FORM:connection:venue=hyperliquid]
[FORM:connection:venue=jupiter]
[FORM:connection:type=email]
```

The frontend parses these from assistant messages and renders the appropriate form inline:

- `[FORM:connection:venue=X]` → renders `<ConnectionForm venue={X} />` inline in the chat
- On success → the frontend sends back `[RESULT:connection:connectionId=abc123]` to the chat
- The chat LLM receives this as context and continues

This is safer than the LLM trying to render HTML forms (which it would hallucinate). The LLM only decides *when* to show a form and *which type* — the frontend owns the actual form rendering and secret handling.

**Form types to support in v1:**

| Marker | Form Component | Purpose |
|--------|---------------|---------|
| `[FORM:connection:venue=hyperliquid]` | Hyperliquid connection form | API key + secret (or wallet) |
| `[FORM:connection:venue=jupiter]` | Jupiter/Solana wallet connect | Wallet connection |
| `[FORM:connection:type=email]` | Email OAuth connect | Gmail/Outlook OAuth |

### Step 6: create_agent Tool (Chat-Specific)

This is a **separate tool** from the worker's `create_bot` tool. It runs in the API context (not the worker), because:

- It needs access to the HTTP request context (user auth)
- It creates agents, not bots
- It's only available to the onboarding chat agent

The tool implementation in `apps/api/src/routes/chat.ts`:

```typescript
const createAgentTool = {
  name: 'create_agent',
  description: 'Create a new AI agent with the specified configuration.',
  parametersSchema: CreateAgentSchema.omit({ /* fields the LLM shouldn't set directly */ }),
  async execute(params, ctx) {
    // Validate against CreateAgentSchema
    // Insert into agents table
    // Return agent ID + post-creation context
  }
};
```

### Step 7: Post-Creation Follow-up

After `create_agent` succeeds, the chat agent receives the created agent's state:

```json
{
  "agentId": "uuid",
  "name": "My Trading Agent",
  "executionMode": "test",
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
- **Thread metadata:** `chat_threads.metadata` tracks `agentCreatedIds: string[]` so created agents can be linked.
- **Post-creation continuity:** Threads remain active after agent creation. Users can create multiple agents in a single thread.
- **Future:** When general Chat With AI ships, it gets its own `/chat` route and sidebar item. The Guided Setup chat is the first use of that infrastructure.

## Verification

- New user (0 agents) lands on the agent creation page, sees Guided Setup greeting with preset buttons
- Greeting is honest about scope (no "ask anything" — it's "I can help you create an AI agent")
- Clicking "AI crypto trader" starts a conversation about trading preferences
- Chat asks about chains, risk, capital
- When connection needed, `[FORM:connection:venue=hyperliquid]` renders inline
- After form completion, chat continues with the connection ID
- Agent created successfully via `create_agent` tool
- Post-creation message includes wallet address and test mode reminder
- "Use the form instead" link switches to the existing Create Agent form
- Returning user who clicks "New Agent" sees tab choice: Guided (Chat) | Form
- Guided is the default tab

## Risks

| Risk | Mitigation |
|------|-----------|
| LLM creates agent with wrong/incomplete config | Zod validation on `create_agent` rejects bad payloads; LLM gets error and retries |
| Chat loops forever asking questions | Max turns per thread (e.g., 20); frontend shows "stuck? use the form" after N turns |
| LLM cost for onboarding | Use a cheap model (e.g., V4 Flash); track as separate cost bucket; show "powered by AI" disclosure |
| Chat not accessible without JS | Graceful fallback: the existing form-based flow remains available |
| Users confused between chat and agent messaging | Clear labeling per product spec; chat is "Chat With AI", agent comms are within agent detail pages |
