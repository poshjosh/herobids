# ADR 005: Onboarding Chat Agent Runtime Model

**Date:** 2026-08-01
**Status:** Proposed

## Context

The AI-First UX feature (005) introduces a chat-based **Guided Setup** experience where users create agents through conversation with an LLM. This chat agent needs to understand platform capabilities, guide users through configuration, and ultimately create agents by calling `POST /agents`.

**v1 scope:** The chat is single-purpose — guide users through the create-agent workflow. It is embedded on the agent creation page, labeled "Guided Setup" in the UI, and does not replace the existing form (it is an alternate, preferred route). General-purpose "Chat With AI" is a future phase; this ADR addresses the runtime model for the guided setup agent specifically, though the model applies to future chat agents as well.

The platform already has two AI surfaces:

1. **AI Employees** — continuously-running agent runtimes with persistent memory, tool access, runtime billing, and tick intervals
2. **Chat With AI** — stateless or session-scoped chat threads with no background execution (defined in `docs/product/chat-with-ai/product-ux-spec.md`)

The onboarding chat agent sits at the intersection: it uses LLM capabilities like an AI Employee but operates within the Chat With AI surface constraints. Without an explicit decision, future developers might assume the chat agent is just a regular agent with a chat UI bolted on, leading to billing or lifecycle bugs.

## Decision

**The onboarding chat agent is a per-message invoked LLM, not a continuously-running agent runtime.**

Specifically:

1. **Invocation model:** The chat agent is invoked synchronously per user message (request/response). It does not tick on an interval, does not run in the background, and terminates after producing a response.

2. **Billing:** It does NOT consume AI Employee runtime billing. It is billed per-token like other Chat With AI usage. No hourly/daily runtime cost.

3. **Tool access (restricted):**
   - `search_app_docs`, `list_app_docs`, `read_app_docs` — platform documentation (new, see Plan 001)
   - `create_agent` — agent creation (runs in API context, not worker)
   - `list_connections` — read-only access to the user's existing connections
   - `send_message` — the chat response IS the message; no external messaging
   
   It does NOT have access to: `submit_decision`, `create_bot`, `get_market_overview`, `execute_code`, memory tools, or any tool that implies continuous operation or trading capability.

4. **Persistence:** Thread history is persisted in new `chat_threads` / `chat_messages` tables, not in agent memory or agent runtime state. Each thread is an independent conversation.

5. **Identity:** The chat agent is NOT an agent row in the `agents` table. It has no `agents.id`, no runtime policy, no tick interval, no skill binding requirements, and no execution mode. It does not appear in the agent list.

6. **Skill system reuse:** The chat agent uses the same skill system (`SYSTEM_SKILLS`, `BASE_SKILL`) for tool assignment. It carries the `platform-docs` and `base` skills. However, skill `bindingRequirements` are not enforced since there is no persistent runtime to bind to.

## Rationale

1. **Billing clarity.** Users must not be charged for continuous runtime when they're having a conversation. Per-message invocation aligns with the Chat With AI billing model and avoids the perception that "chatting costs money even when I'm not talking."

2. **Security boundary.** Restricting tools to read-only docs + agent creation prevents the chat agent from accidentally (or through prompt injection) submitting trades, creating bots, or mutating state beyond creating an agent.

3. **Simplicity.** A per-message invocation model is significantly simpler to implement, debug, and operate than a long-lived agent runtime with a chat interface bolted on. No tick loop, no reconnect logic, no memory reconciliation.

4. **Reuse without coupling.** The skill and tool infrastructure (skill definitions, tool registry, prompt rendering, Zod-to-JSON-Schema conversion) is reused without coupling to the agent runtime lifecycle. This means future chat-based features (support agent, research agent) can follow the same pattern.

5. **Clear upgrade path.** When a user is ready to move from chat to an AI Employee, the conversion is explicit (create agent row, start runtime) — not a silent promotion of a chat thread.

## Consequences

### Positive

1. Clear separation between "talking about agents" and "running agents." Users understand that chat is for planning and setup, AI Employees are for execution.
2. Chat onboarding costs are predictable and low (per-message token costs, no hourly runtime).
3. No risk of the onboarding agent accidentally trading, consuming market data rate limits, or accumulating runtime costs.
4. The tool access model (skills → tools) stays consistent across both surfaces — same skill definitions, different invocation context.
5. Adding future chat-based features (e.g., "support agent" that helps debug) follows the same pattern without new architecture.

### Negative

1. **No persistent memory across threads.** The chat agent cannot remember user preferences from a previous thread. This is by design — each thread is self-contained. If cross-thread memory is needed later, it should be a user profile feature, not a chat agent feature.

2. **Tool implementation split.** `create_agent` runs in the API process (Fastify context), not the worker. This means the tool implementation must handle auth, validation, and DB writes directly rather than delegating to the worker's tool context. This is acceptable because `create_agent` is a simple CRUD operation, not a complex trading workflow.

3. **No agent-context tools.** The chat agent cannot use tools that require an agent ID or execution context (e.g., `get_account_summary`, `get_analytics`). This is acceptable because the chat agent creates agents — it doesn't operate as one. If the user asks "how is my agent doing?", the chat agent can direct them to the agent detail page rather than querying runtime state.

4. **Two code paths for LLM invocation.** The worker invokes agents via the tick loop; the API invokes the chat agent via the chat endpoint. These paths share skill/prompt/tool infrastructure but have different lifecycle management. A future refactor could unify them under a common LLM invocation service, but that's premature for v1.

## Follow-Up Rules

1. **Tool allowlist.** The chat agent must never be given access to `submit_decision`, `create_bot`, `start_bot`, `stop_bot`, or any `execute-trade` or `write-database` category tool. The allowlist is enforced at tool registration time, not at runtime.

2. **New tool review.** Any new tool proposed for the chat agent's allowlist must be explicitly reviewed for consistency with the per-message invocation model. Does it imply continuous operation? Does it need agent identity? Does it mutate trading state? If yes to any, it belongs in AI Employees only.

3. **ADR replacement.** If future requirements demand a chat agent with persistent state, background execution, or trading capability, that must be a new ADR that explicitly replaces or amends this one. Do not silently expand the chat agent's scope.

4. **No agent row.** The chat agent must never be represented as a row in the `agents` table. If an "agent" identity is needed for audit or cost attribution, use a separate `chat_agents` concept or attribute costs to the user directly.

## References

- [AI-First UX Feature Notes](../features/2026/08/01/005-ai-first-ux/000-notes.md)
- [Plan 001: Platform Docs Skill](../features/2026/08/01/005-ai-first-ux/001-platform-docs-skill.md)
- [Plan 002: Onboarding Chat](../features/2026/08/01/005-ai-first-ux/002-onboarding-chat.md)
- [Chat With AI Product UX Spec](../../product/chat-with-ai/product-ux-spec.md)
- [Agent Runtime Boundary And Message Contract](../agents/runtime-boundary-and-message-contract.md)
