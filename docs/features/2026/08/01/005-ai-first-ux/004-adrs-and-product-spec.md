# Assessment: ADRs & Product Spec Updates

**Feature:** AI-First UX (005)
**Date:** 2026-08-01
**Status:** Draft

## ADR Assessment

### ADRs Needed

Two decisions rise to the level of an Architecture Decision Record:

#### ADR 005: Onboarding Chat Agent Runtime Model

**Why an ADR:** The onboarding chat agent operates under a fundamentally different runtime model than existing agents. This has cascading effects on billing, tool access, persistence, and the API surface. Without an explicit ADR, future developers might assume chat agents are just regular agents with a chat UI, leading to billing or lifecycle bugs.

**Key decision to record:**
- The onboarding chat agent is **invoked per-message** (stateless request/response), not continuously ticking
- It does NOT consume AI Employee runtime billing
- It uses a narrow API-local onboarding runtime, not the one-shot `apps/api/src/routes/ai.ts` pattern and not the worker agent runtime
- It has access only to restricted onboarding actions (`*_app_docs`, `list_compatible_connections`, `create_agent`)
- It does NOT have access to trading tools, worker messaging/memory tools, or background execution
- Thread persistence stores only replayable user/assistant messages; summaries and workflow state live in thread metadata or a separate internal store

This is the most important ADR to write. Proposed location: `docs/tech/adrs/2026/08/005-onboarding-chat-agent-runtime-model.md`

#### ADR 006: Structured Actions Contract For LLM-Initiated UI Components (Optional)

**Why this might be an ADR:** The structured `actions` payload is a new cross-cutting contract between the LLM runtime, API, and frontend. It establishes a pattern for how the onboarding runtime requests UI rendering without generating HTML or handling secrets.

**Alternatively:** Document this in the plan and in a tech spec under `docs/tech/agents/`. It's more of a protocol design than an architectural tradeoff. I lean toward **no ADR** — document it in `docs/tech/agents/chat-action-contract.md` instead.

**Decision:** Skip ADR 006. The structured actions contract is adequately covered in Plan 003 and can have a standalone tech doc if needed.

### ADRs NOT Needed

| Topic | Why Not |
|-------|---------|
| `platform-docs` skill separation from `base` | Straightforward design decision; adequately documented in Plan 001 |
| Chat thread DB schema | Standard CRUD; no architectural tradeoff |
| i18n strategy for chat | Follows existing i18n patterns; no new decision |
| Quick-reply buttons vs free text | UX preference, not architecture |

### Recommended Action

Write **ADR 005** only. See template below.

---

## Product UX Spec Update

### Current State

`docs/product/chat-with-ai/product-ux-spec.md` defines Chat With AI as a general-purpose chat surface with these primary use cases:

1. General AI Conversation
2. Personal Assistance
3. Trading-Adjacent Help
4. AI Employee Preparation

### What's Missing

The spec does not cover:

1. **Agent onboarding as a primary use case** — the chat as the default entry point for new users creating their first agent
2. **Embedded action rendering** — backend-owned structured actions for secure inline UI
3. **Tool-calling within chat** — the chat agent having access to chat-safe onboarding actions such as `create_agent`, `*_app_docs`, and `list_compatible_connections`
4. **Quick-reply buttons** — structured UI elements in chat for preset/option selection
5. **Chat → Agent conversion as a first-class flow** — not just "turn this into an AI Employee" as a future action, but as the primary onboarding path

### Recommended Updates to `product-ux-spec.md`

Add or modify these sections:

#### New Use Case: Agent Onboarding

```markdown
### Agent Onboarding

Chat With AI is the default entry point for new users.

Instead of navigating a multi-field form, users describe what they want, and the chat agent
guides them through agent creation conversationally.

Characteristics:
- the chat agent asks follow-up questions based on the selected preset
- connection forms appear inline for wallet and exchange setup
- the agent is created directly from chat when enough information is gathered
- post-creation follow-up messages remind the user of next steps

This use case replaces the form-first Create Agent flow for new users while keeping
the form available as an escape hatch.
```

#### New Section: Embedded Actions

```markdown
### Embedded Actions

Chat messages may contain structured actions that render UI components inline.

Supported action types in v1:
- Quick-reply buttons — for preset selection and guided choices
- Connection forms — secure inline forms for wallet and exchange connections
- Agent confirmation cards — summary before creation

The onboarding runtime returns structured `actions` payloads that the frontend renders.
Assistant text remains display-only. This keeps secrets out of LLM context while allowing the
conversation to guide users through multi-step setup.
```

#### Updated: Relationship To AI Agents → Conversion To AI Employee

```markdown
### Conversion To AI Employee

Two conversion paths exist:

1. **Chat → Agent (onboarding):** The primary path for new users. The chat agent
   collects requirements conversationally and calls create_agent when ready.
   This is the default flow for first-time agent creation.

2. **Chat → Agent (existing thread):** For existing chat threads, a "Turn this into
   an AI Employee" action carries over the conversation context and creates an agent
   from the discussed requirements.
```

#### Updated: v1 Experience → Composer

```markdown
### Composer

The composer should support:
- multiline text input
- send action
- disabled state while a message is being sent
- **quick-reply buttons** rendered above the composer for guided choices

v1 may remain text-only except for quick-reply buttons.
```

### What NOT to Change

- The distinction between Chat and AI Employees remains correct
- The billing boundary remains correct (chat is per-message, AI Employees are continuous)
- The navigation structure (sidebar items) remains correct
- The thread lifecycle model remains correct

---

## ADR 005 Template

```markdown
# ADR 005: Onboarding Chat Agent Runtime Model

**Date:** 2026-08-01
**Status:** Proposed

## Context

The AI-First UX feature introduces a chat-based onboarding experience where users create
agents through conversation with an LLM. This chat agent needs to understand platform
capabilities, guide users through configuration, and ultimately create agents.

The platform already has two AI surfaces:
1. **AI Employees** — continuously-running agent runtimes with persistent memory, 
   tool access, and runtime billing
2. **Chat With AI** — stateless or session-scoped chat threads with no background execution

The onboarding chat agent sits at the intersection: it uses LLM capabilities like an AI
Employee but operates within the Chat With AI surface constraints.

## Decision

**The onboarding chat agent is a per-message invoked LLM, not a continuously-running agent runtime.**

Specifically:

1. The chat agent is invoked synchronously per user message (request/response).
2. It does NOT consume AI Employee runtime billing — it's billed per-token like other chat usage.
3. It uses a narrow API-local onboarding loop rather than the simple one-shot `apps/api/src/routes/ai.ts` pattern.
4. It has access to a restricted onboarding action set appropriate for onboarding:
   - `search_app_docs`, `list_app_docs`, `read_app_docs` — platform documentation
   - `list_compatible_connections` — server-filtered candidate existing connections for reuse
   - `create_agent` — agent creation (runs in API context, not worker)
5. It does NOT have access to trading tools, bot management, worker `send_message`, worker memory persistence, 
   code execution, or any tool that implies continuous operation.
6. Thread history persists only replayable user/assistant messages in `chat_messages`; summaries and workflow state live in `chat_threads.metadata` or a separate internal store.
7. The chat agent is NOT an agent row in the `agents` table — it has no `agents.id`,
   no runtime policy, no tick interval, and no skill binding requirements.
8. It may reuse skill-authored docs/context such as `platform-docs`, but it does not expose the worker runtime `base` skill or worker tool registry directly.

## Rationale

1. **Billing clarity.** Users must not be charged for continuous runtime when they're
   having a conversation. Per-message invocation aligns with the Chat With AI billing model.
2. **Security boundary.** Restricting tools prevents the chat agent from accidentally
   submitting trades or creating bots during onboarding.
3. **Simplicity.** A per-message invocation model is significantly simpler to implement,
   debug, and operate than a long-lived agent runtime with a chat interface bolted on.
4. **Reuse.** The skill and tool infrastructure is reused (skill definitions, tool
   registry, prompt rendering) without coupling to the agent runtime lifecycle.

## Consequences

### Positive

1. Clear separation between "talking about agents" and "running agents."
2. Chat onboarding costs are predictable and low (per-message, not per-hour).
3. No risk of the onboarding agent accidentally trading or consuming resources.
4. The onboarding surface can still reuse existing docs/context concepts without inheriting unsafe worker-runtime assumptions.

### Negative

1. The chat agent cannot maintain persistent memory across threads (by design —
   each thread is self-contained).
2. The onboarding action implementations (`create_agent`, `list_compatible_connections`) must run in the API process,
   not the worker — this means some logic is duplicated or relocated.
3. The chat agent cannot use tools that require a running agent context
   (e.g., `get_account_summary` needs an agent ID). This is acceptable because
   the chat agent creates agents, it doesn't operate as one.

## Follow-Up Rules

1. The chat agent must never be given access to `submit_decision`, `create_bot`,
   or any `execute-trade` category tool.
2. Any new onboarding action added to the chat agent's allowlist must be explicitly reviewed
   for consistency with the per-message invocation model.
3. If future requirements demand a chat agent with persistent state, that must
   be a new ADR that replaces or amends this one.
```
