# Contemplation: Chat Sessions — Conversational Agent UX

**Direction change (2026-07-13):** Shifted from "chat agent" (agent-centric) to "chat session" (session-centric). The session is the durable entity the user interacts with. The agent is a hidden implementation detail that powers responses.

---

## Core Insight

> **The chat session is the product. The agent is the runtime.**

| Mental model | Entity user sees | Entity that persists | Config mutability |
|---|---|---|---|
| Chat session | Session (title, messages) | Session (config, history) | Change skills/LLM mid-session |
| Agent (hidden) | Never exposed | Agent record (for infra) | Synced from session on change |

This inverts the earlier agent-centric design. The user doesn't "create a chat agent" — they "start a chat session." The runtime that powers it is disposable.

---

## Branch 1: What is a chat session?

A chat session is a durable conversation between a user and an AI, backed by the existing agent infrastructure but exposed as a session-first experience.

| Dimension | Trading Agent | Chat Session |
|-----------|-------------|------------|
| User sees | Agent with status, config, controls | Session with messages, title, config |
| Interaction | Autonomous tick-based loop | Event-driven: message → response |
| Tick interval | 15–90 minutes | **None** — message arrival triggers processing |
| Skills | trading, bot-management, risk-monitoring | web-access (default), + optional non-trading skills |
| Programming skill | Available (custom preset) | Explicitly excluded |
| Lifecycle | Long-running, user starts/stops | Active while user chats; idle → paused |
| Config mutability | Static after creation (edit modal) | Changeable mid-session (skills, model, prompt) |
| DB anchor | `agents` table | `chat_sessions` table |

---

## Branch 2: Session-Centric Architecture

### Decision: `chat_sessions` is the primary entity. Agent is hidden infra.

**What the user creates:** A chat session (not an agent).
**What the system creates internally:** A lightweight agent record to reuse the tool execution, skill resolution, and LLM pipeline.

```
User action           System action
───────────           ─────────────
"New Chat"     →      Creates chat_session + hidden agent
Send message   →      Agent runtime (event-driven) processes → response
Change skills  →      Updates chat_session.config; syncs to agent on next message
Archive session→      Marks chat_session.archived; keeps agent dormant
```

### Why not bypass agents entirely?

The existing agent infrastructure provides significant value that would be costly to rebuild:
- **Tool execution** (`search_web`, `browse_url`, `send_message`, `set_memory`, etc.) — battle-tested, circuit-breaker protected, rate-limited
- **Skill resolution** — instruction injection, tool gating, guardrail application
- **LLM pipeline** — provider routing, token counting, cost attribution, thinking-block stripping
- **Memory** — Redis-backed `get_memory`/`set_memory` across messages

Building a separate LLM+tool pipeline for chat sessions would duplicate all of this. Instead, we keep the agent as an implementation detail and make sessions the user-facing entity.

### Why the agent is hidden

- The agent list (`/agents`) shows trading agents only
- Chat sessions appear in a separate list or on a dedicated page
- The agent detail page for chat-backed agents shows the chat UI, not agent controls
- Agent lifecycle (start/stop) is managed automatically — user never sees it

---

## Branch 3: Runtime Model — Event-Driven, No Tick Loop

### The problem with ticks for chat

Current agent runtime: `while(running) { await tick(); await sleep(tickIntervalMs); }`
- Tick interval = 15–90 minutes for trading agents
- Even at 1 second, a polling loop is wasteful for chat (99.9% idle)
- User expects sub-second acknowledgment and 2–10 second response

### Decision: Event-driven via Redis blocking read

Instead of a tick loop, the agent container in chat mode uses `XREAD BLOCK`:

```
while (running) {
  messages = await redis.xread(BLOCK, 30_000, streamKey);
  if (messages) {
    for (const msg of messages) {
      await processMessage(msg);   // LLM call + tools → respond
    }
  }
  if (idleTimeoutExceeded) break;  // auto-pause
}
```

- **`BLOCK 30000`**: Wait up to 30s for a message, then check idle timeout
- **No tick interval config** — the concept doesn't apply
- **Immediate processing**: Message arrives → agent wakes → processes → responds
- **Idle timeout**: If no messages for N minutes, the agent container exits (saves resources)

### Processing a single message turn

```
message arrives (Redis stream)
  → read session config (skills, model, system prompt from chat_sessions)
  → sync agent.skillIds if session config changed
  → compose system prompt (base + skill instructions + session system prompt)
  → LLM call with tools (may include multiple tool-call rounds)
  → persist agent response to chat_messages + agent_outbound_messages
  → deliver via Telegram if channel was Telegram
  → return to blocking wait
```

---

## Branch 4: Data Model

### 4a. `chat_sessions` — the core entity

```sql
chat_sessions (
  id              UUID PK,
  user_id         FK → users NOT NULL,
  agent_id        FK → agents NOT NULL,       -- hidden backing agent
  title           TEXT,                        -- auto-generated from first message
  status          TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'archived'

  -- Mutable session config (can change mid-session)
  system_prompt   TEXT,                        -- custom system prompt (optional)
  skill_ids       TEXT[] NOT NULL DEFAULT '{web-access}',
  model           TEXT,                        -- LLM model (e.g. 'gpt-4o')
  provider        TEXT,                        -- LLM provider

  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL
)
```

Key design points:
- **Session owns its config** — `skill_ids`, `model`, `system_prompt` are on the session, not the agent
- **Config is mutable** — user can add/remove skills mid-conversation; next message uses new config
- **agent_id is internal** — not exposed in UI; used only for infrastructure routing
- **One user → many sessions** — separate conversations, isolated context

### 4b. `chat_messages` — unified message timeline

```sql
chat_messages (
  id              UUID PK,
  chat_session_id FK → chat_sessions NOT NULL,
  user_id         TEXT,                        -- null for agent-authored messages
  direction       TEXT NOT NULL,               -- 'inbound' (user→agent) | 'outbound' (agent→user)
  channel         TEXT NOT NULL,               -- 'direct' | 'telegram'
  body            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL
)
```

**Write paths:**
1. User sends via direct chat → `chat_messages` (inbound, direct) → Redis stream → agent processes
2. User sends via Telegram → `chat_messages` (inbound, telegram) → Redis stream → agent processes
3. Agent responds → `chat_messages` (outbound, channel derived) + `agent_outbound_messages` (delivery tracking)

**Backward compatibility:** For existing trading agents, the UI falls back to reading `agent_outbound_messages` (the current read-only log). Chat sessions exclusively use `chat_messages`.

### 4c. Hidden agent record

When a chat session is created, a backing agent record is inserted with:
- `name`: auto-generated (e.g., `chat-session-{sessionId}`)
- `status`: starts as `starting`, transitions to `running`
- `skillIds`: synced from `chat_sessions.skill_ids` on every message
- `modelPolicy`: synced from `chat_sessions.model`/`provider`
- `capabilityMode`: `'intelligence'` (no trading)
- Hidden from agent list queries (`WHERE is_chat_backing = false`)

Need a flag on the agents table to distinguish chat-backing agents from user-visible agents:
- **Option A**: New `is_chat_backing BOOLEAN DEFAULT FALSE` column ✅
- **Option B**: Convention-based (name prefix `chat-session-`), filtered in queries
- **Option C**: New `agent_type` column (`'trading' | 'chat_backing'`)

**Decision: Option A** — explicit, queryable, no string-parsing fragility.

---

## Branch 5: Creation Flow

### Decision: "New Chat" is not the agent creation form

The existing agent creation form is designed for trading agents (30+ fields, style selector, capital, guardrails, strategy presets). Chat sessions need a dramatically simpler flow.

### 5a. Entry points

| Entry point | What happens |
|---|---|
| **"New Chat" button** (top-level, e.g., on a `/chats` page or navbar) | Opens a minimal creation dialog |
| **"New Chat" within an existing session** | Archives current session, creates new one (new backing agent) |
| **Telegram message to bot** (no existing session) | Auto-creates a session, auto-names it |

### 5b. Minimal creation form

```
┌─────────────────────────────────────┐
│ Start a new chat                    │
│                                     │
│ What's this chat about? (optional)  │
│ ┌─────────────────────────────────┐ │
│ │ e.g. "Research assistant for    │ │
│ │ DeFi protocols"                 │ │
│ └─────────────────────────────────┘ │
│                                     │
│ Skills                              │
│ ☑ Web Access (default)              │
│ ☐ Task Management                   │
│                                     │
│ Model                     [GPT-4o ▼] │
│                                     │
│        [Cancel]  [Start Chat]       │
└─────────────────────────────────────┘
```

Key design decisions:
- **Name not required** — session title auto-generated from first message or goal
- **Skills**: web-access pre-selected, task-management optional, programming/trading excluded
- **Model**: defaults to user's default model, changeable
- **No style, no capital, no guardrails, no tick interval** — these are trading concepts
- **On create**: inserts `chat_sessions` row + hidden `agents` row → starts agent runtime → navigates to session view

### 5c. Config changes mid-session

User can open a settings panel within the chat to change:
- Skills (add/remove web-access, task-management, file-management)
- Model (switch LLM)
- System prompt (custom instructions)

Changes are saved to `chat_sessions` immediately. The next message uses the new config. The hidden agent's config is synced before processing.

### 5d. Programming skill exclusion

`programming` (and all trading skills: `bot-management`, `trading`, `risk-monitoring`) are excluded from the chat skill picker. This is enforced at:
- **UI level**: Skill picker filters to `['web-access', 'task-management', 'file-management']`
- **API level**: Validation rejects programming/trading skill IDs for chat sessions
- **Tool level**: Even if somehow assigned, `execute_code` tool checks session type

---

## Branch 6: Chat UI

### 6a. Placement

Two options for where the chat UI lives:

**Option A: Agent detail page**
- Chat UI replaces "Messages to user" section on `/agents/:id`
- Session list as sidebar within the detail page
- ❌ Tight coupling to agent detail page — which is trading-oriented
- ❌ URL doesn't reflect session identity (`/agents/:id` not `/sessions/:id`)

**Option B: Dedicated chat page  ✅ RECOMMENDED**
- New route: `/chat/:sessionId`
- Purpose-built page, no trading chrome
- URL reflects session identity
- Session list at `/chat` (or as sidebar)
- ✅ Clean separation from trading agent pages

### 6b. Component Tree

```
ChatPage                          ← NEW (route: /chat/:sessionId)
├── ChatSessionSidebar            ← list of user's sessions
│   ├── "New Chat" button
│   └── ChatSessionItem[]         ← title, date, last message preview
├── ChatHeader                    ← session title (editable), settings gear
├── ChatMessageList               ← scrollable message timeline
│   └── ChatMessageBubble[]       ← user (right) / agent (left) + channel badge
├── ChatThinkingIndicator         ← animated dots when agent is processing
└── ChatMessageInput              ← textarea + send button + channel indicator
```

### 6c. Message Bubble Design

Each message shows:
- **Alignment:** User right, agent left
- **Channel badge:** Telegram icon or web chat icon
- **Avatar/name:** "You" for user, session title (or "Assistant") for agent
- **Timestamp:** Relative ("2m ago"), absolute on hover
- **Body:** Plain text (markdown rendering as future enhancement)

### 6d. Real-time Updates

**Decision: Polling every 2 seconds + optimistic UI.**

When user sends a message:
1. Optimistically add user message to the list
2. Show thinking indicator
3. POST to API
4. Poll for response (refetch every 2s)
5. When agent response arrives, remove thinking indicator, add agent bubble

```typescript
const messagesQuery = useQuery({
  queryKey: ['chat-messages', sessionId],
  queryFn: () => chatApi.messages(sessionId),
  refetchInterval: 2000,
});
```

### 6e. Channel indicator in input

The input area shows which channel the user is typing from:
- Web chat (default, always available)
- If message came via Telegram and user is viewing on web, incoming Telegram messages are visible but the web input is labeled "Reply via web"

---

## Branch 7: Agent Runtime Lifecycle (Hidden)

The backing agent's lifecycle is managed automatically:

| Trigger | Action |
|---------|--------|
| Session created | Agent record inserted; container started in event-driven mode |
| Message sent | Agent wakes from XREAD BLOCK, processes, responds, returns to wait |
| Idle 30 min (no messages) | Agent container exits gracefully (saves memory/cpu); agent status → `stopped` |
| New message after idle | Agent container restarted automatically |
| Session archived | Agent stopped; session read-only |
| Session deleted | Agent + session + messages cascade-deleted |

The user never sees agent start/stop. The session remains "active" even when the backing agent is idle — the next message will transparently restart it.

---

## Branch 8: Previous Chat Sessions

### 8a. Session list

A `/chat` page (or sidebar) shows all user sessions:
- Sorted by `updated_at` descending
- Each item: title, last message preview, relative timestamp
- Click to open that session
- "New Chat" button at top

### 8b. Session archiving

- Archiving hides the session from the active list (moves to "Archived" section)
- Archived sessions are read-only
- Can be unarchived (restored to active)
- Deleting a session is permanent (cascade: session + messages + backing agent)

### 8c. Context isolation

Each session has its own conversation history. The LLM context window contains only messages from that session (up to the model's context limit). Cross-session memory (user preferences, facts) is handled by the agent's `set_memory`/`get_memory` Redis store if the user wants persistence across sessions.

---

## Branch 9: Multi-Channel Message Integration

Messages from all channels appear in the unified session timeline:

```
Channel: Telegram  User: "What's ETH price?"
Channel: Agent     Agent: "ETH is currently $3,245 with 2.1% 24h change..."
Channel: Direct    User: "And SOL?"
Channel: Agent     Agent: "SOL is at $142.80, up 4.3% today..."
```

**Routing logic:**
1. **Inbound (user → agent):**
   - Telegram webhook → resolve session (via `telegram_chat_id` + active session lookup) → `chat_messages` + Redis stream
   - Direct chat POST → resolve session (via URL param) → `chat_messages` + Redis stream
2. **Outbound (agent → user):**
   - Agent calls `send_message` → `chat_messages` (for web UI) + `agent_outbound_messages` (for delivery tracking)
   - Telegram delivery only if the inbound message came from Telegram (don't spam Telegram for web-initiated chats)
   - If session has `telegram_chat_id` set, outbound responses also go to Telegram as notifications

---

## Branch 10: Revised Open Questions

These remain unresolved — product decisions needed before planning:

### Q1: One backing agent per session, or one backing agent shared across sessions?

- **Per-session agent**: Clean isolation, but more DB rows and container starts. Session deletion cascades cleanly.
- **Shared agent**: Fewer agent records, but agent config churns (skills change per session). Context isolation harder.

**Recommendation:** Per-session agent. Simpler isolation, cleaner lifecycle. The overhead of additional agent rows is negligible.

### Q2: Should the backing agent be visible in the agent list?

- **Hidden**: Clean UX, sessions are the only user-facing entity. But operators need visibility for debugging.
- **Visible with badge**: Shows in agent list as "Chat" type, not actionable (no start/stop/edit). Useful for debugging.
- **Admin-only visibility**: Hidden from users, visible to operators/admins.

**Recommendation:** Hidden from users, visible to admins. Add `is_chat_backing` filter on agent queries.

### Q3: What skills are available for chat sessions?

Currently proposed: `web-access` (default), `task-management` (optional), `file-management` (optional).

Excluded: `programming`, `bot-management`, `trading`, `risk-monitoring`.

Should `programming` ever be available? Some users may want code execution in chat.

**Recommendation:** Exclude by default, but make it a plan-gated feature (Pro plan can enable programming in chat sessions).

### Q4: How does billing work?

Chat sessions consume LLM tokens per message. Today's model uses `dailySpendBudgetUsd` on the agent. Options:
- Track spend per session, deduct from user's account balance
- Track spend on the backing agent, same as trading agents
- Per-message pricing (simpler for chat)

**Recommendation:** Track on backing agent using existing `dailySpendBudgetUsd`. Since sessions share a user account, total spend across all sessions + trading agents counts against the user's plan limit.

### Q5: What happens to existing "Messages to user" on trading agent detail pages?

- Keep the read-only log for trading agents (existing behavior)
- Chat sessions get the new bidirectional chat UI
- No migration needed — two separate code paths

### Q6: Can a trading agent also have chat sessions?

- Trading agents already have `send_message` capability
- Their outbound messages appear in the current read-only log
- Users can reply via Telegram (existing behavior)
- Should trading agents get the chat UI too?
- **Recommendation:** Phase 2. Keep trading agent messaging as-is. Chat UI is session-first.

### Q7: Session title generation

- Auto-generated from first user message? (e.g., "Research Solana DeFi...")
- Or LLM-generated 2-5 word summary after first exchange?
- Or user-provided at creation time (optional field)?

**Recommendation:** User can optionally provide a goal at creation. If empty, auto-generate title from first user message (first 50 chars). User can rename anytime.

---

## Summary: Revised Architecture

```mermaid
flowchart TD
    subgraph "User Entry Points"
        A["New Chat" button → /chat/new]
        B["/chat/:sessionId — Chat page"]
        C["/chat — Session list"]
    end

    subgraph "Creation Flow"
        D[Minimal dialog: goal, skills, model]
        E[Creates chat_session + hidden agent]
        F[Starts agent in event-driven mode]
    end

    subgraph "Data Layer"
        G[(chat_sessions) — owns config]
        H[(chat_messages) — unified timeline]
        I[(agents) — hidden, is_chat_backing=true]
        J[(agent_outbound_messages) — delivery tracking]
    end

    subgraph "Chat UI"
        K[ChatSessionSidebar]
        L[ChatMessageList]
        M[ChatMessageInput]
        N[Polling: refetchInterval 2s]
    end

    subgraph "Runtime (event-driven, no ticks)"
        O[Redis Stream: agent:inbound:{agentId}]
        P[Agent Container — XREAD BLOCK]
        Q[LLM + Tool Execution]
        R[send_message → dual write]
    end

    subgraph "External Channels"
        S[Telegram Webhook]
    end

    A --> D --> E --> F --> B
    C --> B
    B --> K --> L
    M -->|POST /chat-sessions/:id/messages| O
    S -->|resolve session| H
    S --> O
    O --> P --> Q --> R --> H
    R --> J
    N -->|GET /chat-sessions/:id/messages| H
    K -->|GET /chat-sessions| G
```

---

## Scope & Packages Affected

| Package | Changes |
|---------|---------|
| **domain** | New types: `ChatSession`, `ChatMessage`, `ChatSessionConfig`. |
| **db** | New tables: `chat_sessions`, `chat_messages`. New column: `agents.is_chat_backing`. Migration. Repositories. |
| **api** | New routes: `POST /chat-sessions`, `GET /chat-sessions`, `GET /chat-sessions/:id`, `PATCH /chat-sessions/:id`, `POST /chat-sessions/:id/messages`, `GET /chat-sessions/:id/messages`, `DELETE /chat-sessions/:id`. Session config validation. Inbound message persistence. |
| **worker** | Event-driven agent mode (XREAD BLOCK instead of tick loop). Session config sync before message processing. Idle timeout. Dual-write `chat_messages` on `send_message`. |
| **web** | New pages: `ChatPage`, `ChatSessionList`. New components: `ChatMessageList`, `ChatMessageBubble`, `ChatMessageInput`, `ChatThinkingIndicator`. New "New Chat" entry point. API client additions. Routes. i18n. |
| **llm** | No changes — chat sessions use the same LLM pipeline via the backing agent. |
| **engine** | No changes — tool execution, risk gate, broker all work through the backing agent. |